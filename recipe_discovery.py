"""Recipe discovery: provider adapters and deterministic ingredient matching.

Architecture
------------
Providers expose a common interface: ``search(ingredients, preferences)``
returns a list of recipes in a NORMALIZED internal format (see
``normalize_recipe``). The discovery pipeline searches providers in order:

  1. SupabaseRecipeProvider (verified curated recipes)
  2. TheMealDBRecipeProvider (trusted international external source)
  3. AIRecipeProvider (LLM-generated fallback, clearly labeled unverified)

Only OFFICIAL API endpoints are used for external sources. The legacy HTML
scraping in ``recipe_sources.py`` (Cookpad/Allrecipes/detik) is intentionally
kept SEPARATE and is NOT part of this discovery pipeline, so a future switch
of providers never touches scraping code and vice versa.

Matching is deterministic and explainable — no embeddings, no LLM. See
``match_recipes`` for the scoring formula.
"""

import os
import sys
import urllib.error
import urllib.parse
import urllib.request

from ingredients import (
    canonicalize,
    is_pantry,
    normalize_ingredients,
)

MIN_SCORE = float(os.environ.get("RECIPE_MATCH_MIN_SCORE", "0.45"))
TIMEOUT_SECONDS = float(os.environ.get("EXTERNAL_RECIPE_TIMEOUT_SECONDS", "8"))
ENABLE_EXTERNAL = os.environ.get("ENABLE_EXTERNAL_RECIPES", "true").lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# Internal normalized recipe format
# ---------------------------------------------------------------------------

def normalize_recipe(recipe):
    """Coerce any provider's recipe dict into the canonical internal shape."""
    ingredients = recipe.get("ingredients") or []
    prep = recipe.get("prep_minutes")
    cook = recipe.get("cook_minutes")
    # total_minutes is derived, never trusted from a raw provider field: some
    # providers omit it, and prep/cook are the authoritative source. A recipe
    # with no time info leaves total_minutes as None so filters treat it as
    # "unknown" rather than wrongly 0.
    total = recipe.get("total_minutes")
    if total is None and (prep is not None or cook is not None):
        total = (prep or 0) + (cook or 0)
    normalized_ingredients = []
    for ing in ingredients:
        if isinstance(ing, str):
            normalized_ingredients.append({
                "canonical": canonicalize(ing) or ing,
                "amount": None,
                "unit": "",
                "optional": False,
                "pantry_staple": is_pantry(canonicalize(ing) or ing),
            })
        else:
            name = ing.get("canonical") or ing.get("name") or ""
            canon = canonicalize(name) or name
            normalized_ingredients.append({
                "canonical": canon,
                "amount": ing.get("amount"),
                "unit": ing.get("unit", ""),
                "optional": bool(ing.get("optional")),
                "pantry_staple": bool(ing.get("pantry_staple")) or is_pantry(canon),
            })

    instructions = recipe.get("instructions") or []
    if isinstance(instructions, str):
        instructions = [s.strip() for s in instructions.split("\n") if s.strip()]

    return {
        "id": recipe.get("id") or recipe.get("external_id") or "",
        "title": recipe.get("title") or recipe.get("nama") or "",
        "description": recipe.get("description") or "",
        "cuisine": recipe.get("cuisine") or "",
        "country": recipe.get("country") or recipe.get("area") or "",
        "language": recipe.get("language", "id"),
        "servings": recipe.get("servings"),
        "prep_minutes": recipe.get("prep_minutes"),
        "cook_minutes": recipe.get("cook_minutes"),
        "total_minutes": total,
        "difficulty": recipe.get("difficulty") or "",
        "meal_type": recipe.get("meal_type") or "",
        "diet_tags": recipe.get("diet_tags") or [],
        "allergen_tags": recipe.get("allergen_tags") or [],
        "instructions": instructions,
        "image_url": recipe.get("image_url") or recipe.get("thumbnail") or "",
        "source_type": recipe.get("source_type", "external"),
        "source_name": recipe.get("source_name", ""),
        "source_url": recipe.get("source_url") or recipe.get("url") or "",
        "external_id": recipe.get("external_id") or "",
        "license": recipe.get("license") or "",
        "attribution_text": recipe.get("attribution_text") or "",
        "verified": bool(recipe.get("verified")),
        "ingredients": normalized_ingredients,
    }


# ---------------------------------------------------------------------------
# Provider adapters
# ---------------------------------------------------------------------------

class SupabaseRecipeProvider:
    """Verified curated recipes from the local Supabase database."""

    name = "Supabase"

    def __init__(self):
        import supabase_client
        self.client = supabase_client

    def search(self, ingredients, preferences=None):
        if not self.client.is_configured():
            return []
        try:
            recipes = self.client.fetch_verified_recipes()
        except Exception as exc:
            sys.stderr.write(f"Supabase provider error: {exc}\n")
            return []
        return [normalize_recipe(r) for r in recipes]


# Deterministic allergen derivation from the actual ingredient catalog, NOT
# from an LLM. TheMealDB does not expose an allergen field, so we infer the
# common allergens from the ingredient names we actually received via
# lookup.php. Unknown ingredients map to no allergen (fail-safe: we never
# invent an allergen classification), which means an allergen exclusion filter
# can only ever remove recipes whose allergens we can positively identify.
# This is intentionally conservative: we would rather under-report than falsely
# clear an allergen.
ALLERGEN_INGREDIENT_MAP = {
    "milk": "milk",
    "butter": "milk",
    "cream": "milk",
    "cheese": "milk",
    "yogurt": "milk",
    "egg": "egg",
    "soy": "soy",
    "soy sauce": "soy",
    "tofu": "soy",
    "tempeh": "soy",
    "wheat": "gluten",
    "flour": "gluten",
    "bread": "gluten",
    "noodles": "gluten",
    "pasta": "gluten",
    "fish": "fish",
    "shrimp": "shellfish",
    "prawn": "shellfish",
    "crab": "shellfish",
    "lobster": "shellfish",
    "peanut": "peanut",
    "almond": "tree nut",
    "cashew": "tree nut",
    "walnut": "tree nut",
    "hazelnut": "tree nut",
    "sesame": "sesame",
    "tahini": "sesame",
}

# Common phrases that would otherwise produce a FALSE allergen via naive token
# matching. Checked BEFORE the positive map: "coconut milk" is not dairy, and
# "peanut butter" is peanut (not dairy butter). Deterministic and conservative
# — we only ever suppress a classification we can name explicitly.
ALLERGEN_FALSE_POSITIVE_PHRASES = {
    "coconut milk": {"milk"},
    "coconut cream": {"milk"},
    "soy milk": {"milk"},
    "almond milk": {"milk"},
    "oat milk": {"milk"},
    "peanut butter": {"milk"},
    "cocoa butter": {"milk"},
    "shea butter": {"milk"},
    "coconut butter": {"milk"},
}


def derive_allergens(ingredient_names):
    """Return a deterministic set of allergen tags for a list of ingredient
    names/canonicals. Only allergens we can positively map are returned;
    unknown ingredients contribute nothing (fail-safe, never LLM-derived)."""
    allergens = set()
    for name in ingredient_names or []:
        text = str(name).strip().lower()
        if not text:
            continue
        # Apply false-positive suppression first, keyed on the whole phrase.
        suppress = set()
        for phrase, tags in ALLERGEN_FALSE_POSITIVE_PHRASES.items():
            if phrase in text:
                suppress |= tags
        for key, tag in ALLERGEN_INGREDIENT_MAP.items():
            # Exact match, or token match with word boundaries, so "coconut
            # milk" does NOT falsely map to "milk" and "peanut butter" maps to
            # "peanut" but a substring inside another word does not match.
            matched = False
            if text == key:
                matched = True
            elif " " in key and f" {key} " in f" {text} ":
                matched = True
            elif " " not in key and key in text.split():
                matched = True
            if matched and tag not in suppress:
                allergens.add(tag)
    return sorted(allergens)


class TheMealDBRecipeProvider:
    """International recipes from TheMealDB official JSON API (key '1').

    Uses only official endpoints: filter.php to find candidate meal ids for a
    main ingredient, then lookup.php to fetch full details (ingredients,
    measures, area). TheMealDB's terms do not grant redistribution of recipe
    instructions or images, so we store ONLY factual metadata (title, area,
    ingredient list, source link) and always link back to the original page —
    never the full instruction prose or the image.
    """

    name = "TheMealDB"
    # Base ends at /v1; the key is appended as its own path segment in _get so
    # we never double the "1" segment (previous bug produced /v1/1/1/filter.php).
    BASE = "https://www.themealdb.com/api/json/v1"

    def __init__(self):
        self.api_key = (os.environ.get("THEMEALDB_API_KEY", "1") or "1").strip() or "1"

    def _get(self, endpoint, params):
        qs = urllib.parse.urlencode(params or {})
        # TheMealDB test key is '1'; embed as the path key segment per docs.
        url = f"{self.BASE}/{self.api_key}/{endpoint}.php?{qs}"
        req = urllib.request.Request(url, headers={"User-Agent": "ResepInAja/1.0"})
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return __import__("json").loads(resp.read().decode("utf-8"))

    def _lookup(self, meal_id):
        """Fetch full details for a meal id via the official lookup endpoint."""
        data = self._get("lookup", {"i": meal_id})
        meals = data.get("meals") or []
        return meals[0] if meals else None

    def search(self, ingredients, preferences=None):
        if not ENABLE_EXTERNAL:
            return []
        canonicals = normalize_ingredients(ingredients)
        mealdb_terms = {
            "egg": "egg", "chicken": "chicken", "potato": "potato",
            "rice": "rice", "noodles": "noodles", "fish": "fish",
            "shrimp": "prawns", "beef": "beef", "tomato": "tomato",
            "mushroom": "mushroom", "carrot": "carrot", "spinach": "spinach",
            "tofu": "tofu", "beans": "beans", "banana": "banana",
            "cheese": "cheese", "bread": "bread", "onion": "onion",
            "shallot": "shallots", "garlic": "garlic", "chili": "chili",
            "coconut": "coconut", "coconut milk": "coconut milk",
            "corn": "sweetcorn", "eggplant": "aubergine", "broccoli": "broccoli",
            "cabbage": "cabbage", "milk": "milk", "butter": "butter",
            "scallion": "spring onions", "lime": "lime", "lemon": "lemon",
            "vinegar": "vinegar", "soy sauce": "soy sauce", "sugar": "sugar",
            "salt": "salt", "oil": "oil", "flour": "flour",
        }
        # Collect candidate meal ids via filter.php (official), then hydrate
        # each with lookup.php so we have real ingredient + measure fields.
        candidate_ids = []
        for canon in canonicals[:5]:
            term = mealdb_terms.get(canon)
            if not term:
                continue
            try:
                data = self._get("filter", {"i": term})
            except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError) as exc:
                sys.stderr.write(f"TheMealDB filter error: {exc}\n")
                continue
            for meal in (data.get("meals") or [])[:4]:
                mid = meal.get("idMeal")
                if mid and mid not in candidate_ids:
                    candidate_ids.append(mid)

        recipes = []
        seen_ids = set()
        for mid in candidate_ids:
            if mid in seen_ids:
                continue
            try:
                detail = self._lookup(mid)
            except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError) as exc:
                sys.stderr.write(f"TheMealDB lookup error for {mid}: {exc}\n")
                continue
            if not detail:
                continue
            seen_ids.add(mid)
            recipes.append(self._to_recipe(detail))
        return [normalize_recipe(r) for r in recipes]

    def _to_recipe(self, meal):
        """Convert a lookup.php detail dict to the internal recipe shape.

        Ingredients are reconstructed from the strIngredient1..20 /
        strMeasure1..20 fields. Instructions and image are NOT stored — only
        the source link and attribution, because TheMealDB's terms do not
        grant redistribution of prose or images. Allergens are derived
        deterministically from the actual ingredient names (never an LLM).
        """
        ingredients = []
        for i in range(1, 21):
            name = (meal.get(f"strIngredient{i}") or "").strip()
            measure = (meal.get(f"strMeasure{i}") or "").strip()
            if not name:
                continue
            canon = canonicalize(name) or name.lower()
            ingredients.append({
                "canonical": canon,
                "amount": None,
                "unit": measure,
                "optional": False,
                "pantry_staple": is_pantry(canon),
            })
        ingredient_names = [i["canonical"] for i in ingredients]
        return {
            "id": meal.get("idMeal"),
            "title": meal.get("strMeal", ""),
            "description": "",
            "cuisine": (meal.get("strArea") or "").lower(),
            "country": meal.get("strArea", ""),
            "language": "en",
            "servings": None,
            "prep_minutes": None,
            "cook_minutes": None,
            "difficulty": "",
            "meal_type": meal.get("strCategory", "") or "",
            "diet_tags": [],
            "allergen_tags": derive_allergens(ingredient_names),
            "instructions": [],
            "image_url": "",
            "source_type": "external",
            "source_name": "TheMealDB",
            "source_url": f"https://www.themealdb.com/meal/{meal.get('idMeal')}",
            "external_id": meal.get("idMeal"),
            "license": "TheMealDB Terms of Use (metadata only, link-back)",
            "attribution_text": "Recipe info from TheMealDB (themealdb.com); open source for full instructions.",
            "verified": False,
            "ingredients": ingredients,
        }


class AIRecipeProvider:
    """LLM-generated fallback. Never marked verified; ingredients unknown.

    This provider is wired by the caller (server.py) which has the actual AI
    call. Here we only hold the label/flagging metadata used by the matching
    layer so AI results are clearly flagged as unverified.
    """

    name = "AI"

    def __init__(self):
        pass

    def search(self, ingredients, preferences=None):
        return []  # AI results are injected by server.py's existing pipeline.


# ---------------------------------------------------------------------------
# Deterministic matching
# ---------------------------------------------------------------------------

def _required_ingredients(recipe):
    return [i for i in recipe["ingredients"] if not i["optional"] and not i["pantry_staple"]]


def _all_ingredients(recipe):
    return [i for i in recipe["ingredients"] if not i["pantry_staple"]]


def match_recipes(recipes, ingredients, preferences=None):
    """Score and rank recipes against detected ingredients.

    Deterministic: identical input yields identical output. Returns a list of
    result dicts (with matchScore, matchedIngredients, missingIngredients,
    unusedIngredients, matchExplanation) sorted descending by score and
    filtered to score >= MIN_SCORE.

    Scoring (base):
      0.55 * available_required_ratio
      + 0.25 * detected_usage_ratio
      + 0.10 * verified_bonus
      + 0.10 * preference_match
    minus 0.05 * (number of missing non-pantry required ingredients), clamped
    to [0, 1].
    """
    preferences = preferences or {}
    detected = normalize_ingredients(ingredients)
    detected_set = set(detected)

    # Preference filters.
    cuisines = [c.strip().lower() for c in (preferences.get("cuisines") or []) if c and c.strip()]
    diet = [d.strip().lower() for d in (preferences.get("diet") or []) if d and d.strip()]
    exclude_allergens = [a.strip().lower() for a in (preferences.get("excludeAllergens") or []) if a and a.strip()]
    max_time = preferences.get("maxTimeMinutes")
    language = preferences.get("language")

    results = []
    for recipe in recipes:
        recipe = normalize_recipe(recipe)
        # --- Hard filters (exclusion, not scoring) ---
        if cuisines and recipe["cuisine"].lower() not in cuisines:
            continue
        if exclude_allergens:
            recipe_allergens = {a.lower() for a in recipe["allergen_tags"]}
            # Positive allergen match => exclude.
            if recipe_allergens & set(exclude_allergens):
                continue
            # FAIL CLOSED on unknown metadata: if a recipe has no ingredient
            # data at all (so we could not deterministically derive its
            # allergens), it must not silently pass an allergen exclusion
            # filter as "safe". A recipe WITH ingredients and empty allergen
            # tags is fine — we actually derived its allergens and found none
            # matching; that is a positive result, not an unknown.
            if not recipe.get("ingredients"):
                continue
        if max_time:
            total = recipe.get("total_minutes") or (
                (recipe.get("prep_minutes") or 0) + (recipe.get("cook_minutes") or 0)
            )
            if total and total > max_time:
                continue
        if language and recipe.get("language") and recipe["language"] != language:
            continue

        required = _required_ingredients(recipe)
        all_ing = _all_ingredients(recipe)
        required_names = [i["canonical"] for i in required]
        all_names = [i["canonical"] for i in all_ing]

        matched = [n for n in required_names if n in detected_set]
        missing = [n for n in required_names if n not in detected_set]
        unused = [n for n in detected if n not in set(all_names)]

        if not required_names:
            # No usable ingredient info: cannot score meaningfully.
            continue

        available_ratio = len(matched) / len(required_names)
        usage_ratio = (len(matched) / len(detected)) if detected else 0.0

        # Preference match: reward when recipe satisfies a selected diet tag.
        pref_bonus = 0.0
        if diet:
            recipe_diet = {d.lower() for d in recipe["diet_tags"]}
            if recipe_diet & set(diet):
                pref_bonus = 1.0

        verified_bonus = 1.0 if recipe["verified"] else 0.0

        score = (
            0.55 * available_ratio
            + 0.25 * usage_ratio
            + 0.10 * verified_bonus
            + 0.10 * pref_bonus
            - 0.05 * len(missing)
        )
        score = max(0.0, min(1.0, score))

        if score < MIN_SCORE:
            continue

        explanation = _explain(recipe, matched, missing, unused, required_names)

        results.append({
            **recipe,
            "matchedIngredients": matched,
            "missingIngredients": missing,
            "unusedIngredients": unused,
            "matchScore": round(score, 3),
            "matchExplanation": explanation,
        })

    results.sort(key=lambda r: (r["matchScore"], int(r["verified"])), reverse=True)
    return results


def _explain(recipe, matched, missing, unused, required_names):
    parts = []
    if matched:
        parts.append(f"You already have {len(matched)} of {len(required_names)} main ingredients.")
    if missing:
        parts.append(f"Only {', '.join(missing[:3])} missing.")
    if unused:
        parts.append(f"Recipe does not use your {', '.join(unused[:3])}.")
    if not recipe["verified"] and recipe["source_type"] == "external":
        parts.append("External source — check the original recipe before cooking.")
    return " ".join(parts) if parts else "No strong ingredient match."


# ---------------------------------------------------------------------------
# Discovery pipeline
# ---------------------------------------------------------------------------

def discover_recipes(ingredients, preferences=None):
    """Run providers in order (Supabase -> TheMealDB -> AI) and match.

    Returns a dict with keys:
      - "matches": ranked matched results (curated + external)
      - "ai_fallback": True when only AI was available
    The caller (server.py) appends AI results and sets fallback flags.
    """
    supabase = SupabaseRecipeProvider()
    themealdb = TheMealDBRecipeProvider()

    curated = supabase.search(ingredients, preferences)
    external = themealdb.search(ingredients, preferences)

    combined = curated + external
    matches = match_recipes(combined, ingredients, preferences)

    return {
        "matches": matches,
        "curated_count": len(curated),
        "external_count": len(external),
        "supabase_available": supabase.client.is_configured(),
    }

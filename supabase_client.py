"""Supabase REST adapter for the recipe discovery system.

Uses ONLY the publishable (anon) key on the backend — never the service-role
key. Row Level Security (see supabase_schema.sql) ensures the anon role can
only SELECT verified public recipes and cannot write to recipe tables.

The adapter is optional: if Supabase is not configured or unreachable, it
returns empty results so the rest of the discovery pipeline (TheMealDB, then
AI fallback) can still run. No secrets are ever returned to the frontend.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
# Accept SUPABASE_ANON_KEY (documented) with SUPABASE_PUBLISHABLE_KEY as an
# alias so existing deployments that used the spec's placeholder name keep
# working. Either must be the publishable/anon key — never the service-role key.
SUPABASE_ANON_KEY = (
    os.environ.get("SUPABASE_ANON_KEY", "").strip()
    or os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip()
)
TIMEOUT_SECONDS = float(os.environ.get("EXTERNAL_RECIPE_TIMEOUT_SECONDS", "8"))


def is_configured():
    """True if Supabase URL and anon key are both set."""
    return bool(SUPABASE_URL and SUPABASE_ANON_KEY)


def _request(path, params=None):
    """Perform an authenticated GET against the Supabase REST API.

    Raises on transport/HTTP errors; callers decide how to degrade.
    """
    url = SUPABASE_URL + "/rest/v1" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
            "Accept": "application/json",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_verified_recipes():
    """Return verified public recipes (with ingredients) from Supabase.

    Returns a list of dicts in the internal recipe format, or [] on any error.
    """
    if not is_configured():
        return []
    try:
        recipes = _request("/recipes", {"verified": "eq.true", "select": "*"})
        ingredients = _request("/recipe_ingredients", {"select": "*"})
    except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError) as exc:
        sys.stderr.write(f"Supabase unavailable: {exc}\n")
        return []

    # Build ingredient lookup by recipe_id.
    ing_by_recipe = {}
    for row in ingredients:
        ing_by_recipe.setdefault(row.get("recipe_id"), []).append(row)

    result = []
    for r in recipes:
        ing_rows = ing_by_recipe.get(r.get("id"), [])
        result.append({
            "id": r.get("id"),
            "title": r.get("title"),
            "description": r.get("description"),
            "cuisine": r.get("cuisine"),
            "country": r.get("country"),
            "language": r.get("language", "id"),
            "servings": r.get("servings"),
            "prep_minutes": r.get("prep_minutes"),
            "cook_minutes": r.get("cook_minutes"),
            "difficulty": r.get("difficulty"),
            "meal_type": r.get("meal_type"),
            "diet_tags": r.get("diet_tags") or [],
            "allergen_tags": r.get("allergen_tags") or [],
            "instructions": r.get("instructions") or [],
            "image_url": r.get("image_url"),
            "source_type": r.get("source_type", "curated"),
            "source_name": r.get("source_name"),
            "source_url": r.get("source_url"),
            "external_id": r.get("external_id"),
            "license": r.get("license"),
            "attribution_text": r.get("attribution_text"),
            "verified": bool(r.get("verified")),
            "ingredients": [
                {
                    "canonical": ing.get("canonical_name"),
                    "amount": ing.get("amount"),
                    "unit": ing.get("unit"),
                    "optional": bool(ing.get("optional")),
                    "pantry_staple": bool(ing.get("pantry_staple")),
                }
                for ing in ing_rows
            ],
        })
    return result


def get_recipe(recipe_id):
    """Fetch a single recipe by id, or None."""
    if not is_configured():
        return None
    try:
        rows = _request("/recipes", {"id": f"eq.{recipe_id}", "select": "*"})
    except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError):
        return None
    if not rows:
        return None
    # Reuse the bulk fetch but filter to this id for a consistent shape.
    for r in fetch_verified_recipes():
        if r["id"] == recipe_id:
            return r
    return None

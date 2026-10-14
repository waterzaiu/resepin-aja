"""Ingredient normalization, multilingual aliases, and pantry-item handling.

This module is the single source of truth for how ingredient names are
normalized and matched against recipes. It is deterministic (no LLM, no
network) so tests and the matching algorithm can rely on stable output.

The alias map is intentionally small and curated: it covers common
Indonesian <-> English terms plus the international terms used by the seed
data. Extend `INGREDIENT_ALIASES` to add more languages.
"""

import re

# Canonical English term for each alias. A canonical name is the key used
# when comparing ingredients to recipe ingredient lists.
# id -> en aliases (Indonesian is the primary second language for this app).
INGREDIENT_ALIASES = {
    # Indonesian -> English
    "telur": "egg",
    "ayam": "chicken",
    "daging ayam": "chicken",
    "kentang": "potato",
    "nasi": "rice",
    "beras": "rice",
    "mie": "noodles",
    "mi": "noodles",
    "indomie": "noodles",
    "ikan": "fish",
    "udang": "shrimp",
    "daging": "beef",
    "daging sapi": "beef",
    "sapi": "beef",
    "tomat": "tomato",
    "jamur": "mushroom",
    "wortel": "carrot",
    "bayam": "spinach",
    "kangkung": "water spinach",
    "tahu": "tofu",
    "tempe": "tempeh",
    "kacang": "beans",
    "pisang": "banana",
    "keju": "cheese",
    "roti": "bread",
    "bawang": "onion",
    "bawang merah": "shallot",
    "bawang putih": "garlic",
    "cabai": "chili",
    "cabe": "chili",
    "santan": "coconut milk",
    "kelapa": "coconut",
    "jagung": "corn",
    "ubi": "sweet potato",
    "singkong": "cassava",
    "terong": "eggplant",
    "brokoli": "broccoli",
    "kol": "cabbage",
    "kubis": "cabbage",
    "sawi": "mustard greens",
    "buncis": "green beans",
    "lada": "pepper",
    "merica": "pepper",
    "gula": "sugar",
    "garam": "salt",
    "minyak": "oil",
    "minyak goreng": "oil",
    "kecap": "soy sauce",
    "kecap manis": "sweet soy sauce",
    "tepung": "flour",
    "tepung terigu": "flour",
    "susu": "milk",
    "mentega": "butter",
    "daun bawang": "scallion",
    "air": "water",
    "jeruk": "lime",
    "jeruk nipis": "lime",
    "jeruk lemon": "lemon",
    "cuka": "vinegar",
    "terasi": "shrimp paste",
    "saus tiram": "oyster sauce",
    "kaldu": "stock",
    # English (identity, for case/whitespace normalization)
    "egg": "egg",
    "chicken": "chicken",
    "potato": "potato",
    "rice": "rice",
    "noodles": "noodles",
    "noodle": "noodles",
    "fish": "fish",
    "shrimp": "shrimp",
    "prawn": "shrimp",
    "beef": "beef",
    "tomato": "tomato",
    "mushroom": "mushroom",
    "carrot": "carrot",
    "spinach": "spinach",
    "tofu": "tofu",
    "tempeh": "tempeh",
    "beans": "beans",
    "banana": "banana",
    "cheese": "cheese",
    "bread": "bread",
    "onion": "onion",
    "shallot": "shallot",
    "garlic": "garlic",
    "chili": "chili",
    "chilli": "chili",
    "coconut": "coconut",
    "coconut milk": "coconut milk",
    "corn": "corn",
    "sweet potato": "sweet potato",
    "cassava": "cassava",
    "eggplant": "eggplant",
    "aubergine": "eggplant",
    "broccoli": "broccoli",
    "cabbage": "cabbage",
    "pepper": "pepper",
    "sugar": "sugar",
    "salt": "salt",
    "oil": "oil",
    "soy sauce": "soy sauce",
    "sweet soy sauce": "sweet soy sauce",
    "flour": "flour",
    "milk": "milk",
    "butter": "butter",
    "scallion": "scallion",
    "spring onion": "scallion",
    "water": "water",
    "lime": "lime",
    "lemon": "lemon",
    "vinegar": "vinegar",
    "oyster sauce": "oyster sauce",
    "stock": "stock",
}

# Common pantry staples that should NOT unfairly lower a recipe's match score
# when missing (every kitchen is assumed to have them). These are handled
# specially by the matching algorithm.
PANTRY_ITEMS = {
    "salt",
    "water",
    "oil",
    "sugar",
    "pepper",
    "salt and pepper",
}

# Words that frequently appear in AI ingredient descriptions but are not
# ingredients themselves.
_NON_INGREDIENT = {
    "rasa", "goreng", "segar", "bungkus", "buah", "potong", "merk", "kemasan",
    "bahan", "dapur", "sisa", "seperempat", "setengah", "iris", "cincang",
    "gram", "kg", "ml", "sendok", "sdt", "sdm", "buah", "butir", "siung",
}


def canonicalize(ingredient):
    """Normalize a raw ingredient string to its canonical English term.

    Handles case, surrounding whitespace, punctuation, and multi-word aliases.
    Returns the canonical name, or None if the input is empty noise.

    Deterministic: identical input always yields identical output.
    """
    if ingredient is None:
        return None
    text = str(ingredient).strip().lower()
    if not text:
        return None
    # Strip common quantity prefixes and trailing punctuation.
    text = re.sub(r"[^\w\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    # Try longest alias first so "daging sapi" beats "sapi".
    for alias in sorted(INGREDIENT_ALIASES, key=len, reverse=True):
        if text == alias:
            return INGREDIENT_ALIASES[alias]
    # Fall back to word-by-word translation for single tokens.
    words = [w for w in text.split() if w not in _NON_INGREDIENT and len(w) > 1]
    if not words:
        return None
    # If every word maps to an alias, translate them; otherwise return the
    # cleaned text so we don't silently drop unknown ingredients.
    translated = [INGREDIENT_ALIASES.get(w, w) for w in words]
    if any(INGREDIENT_ALIASES.get(w) for w in words):
        # Prefer the whole-string canonical form when the joined result is a
        # known alias (e.g. "sweet soy sauce").
        joined = " ".join(dict.fromkeys(translated))
        if joined in INGREDIENT_ALIASES.values():
            return joined
        return INGREDIENT_ALIASES.get(words[0], translated[0])
    return " ".join(dict.fromkeys(translated))


def normalize_ingredients(ingredients):
    """Normalize a list of raw ingredients to a deduplicated list of canonicals.

    Order is preserved; duplicates are removed. Unknown-but-valid ingredients
    are kept as cleaned strings so they can still match recipe titles.
    """
    seen = set()
    out = []
    for item in ingredients if isinstance(ingredients, list) else []:
        canon = canonicalize(item)
        if canon and canon not in seen:
            seen.add(canon)
            out.append(canon)
    return out


def is_pantry(canonical_ingredient):
    """True if the canonical ingredient is a pantry staple."""
    return canonical_ingredient in PANTRY_ITEMS


def alias_languages(ingredient):
    """Return the set of aliases that map to this canonical ingredient.

    Useful for debugging and for the API to explain normalization.
    """
    target = canonicalize(ingredient)
    if not target:
        return []
    return sorted(a for a, c in INGREDIENT_ALIASES.items() if c == target)

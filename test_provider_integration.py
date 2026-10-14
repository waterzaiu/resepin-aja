"""Mocked provider integration tests for the deterministic discovery backend.

These tests exercise TheMealDBRecipeProvider (and the matching pipeline) with
FULLY MOCKED network responses — no live API calls, no quotas consumed. They
pin the exact URLs the provider builds (so the /v1/1 double-key bug can never
regress), verify the lookup.php detail fetch, deterministic allergen
derivation, fail-safe handling of unknown/absent allergen metadata, malformed
inputs, timeouts, and external-provider unavailability.

All mocks are hermetic; every test is deterministic (identical input => identical
output).
"""

import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import recipe_discovery
from recipe_discovery import TheMealDBRecipeProvider, derive_allergens, normalize_recipe


def _lookup_meal(meal_id, title, area="American", ingredients=None):
    """Build a realistic lookup.php response dict for a meal id."""
    detail = {
        "idMeal": meal_id,
        "strMeal": title,
        "strCategory": "Main",
        "strArea": area,
        "strInstructions": "This is copyrighted prose we must not store.",
        "strMealThumb": f"https://www.themealdb.com/images/media/meals/{meal_id}.jpg",
    }
    for i in range(1, 21):
        detail[f"strIngredient{i}"] = ""
        detail[f"strMeasure{i}"] = ""
    for i, name in enumerate(ingredients or [], start=1):
        detail[f"strIngredient{i}"] = name
        detail[f"strMeasure{i}"] = f"{i} cup"
    return detail


class TestTheMealDBProviderURLs(unittest.TestCase):
    """Pin the URL the provider constructs so the /v1/1 double-key regression
    is impossible."""

    def _urlopen(self, url, *a, **k):
        # urlopen is called with a Request object; record its full URL.
        self.urls.append(getattr(url, "full_url", url))
        raise OSError("stop after recording URL")

    def test_filter_url_has_single_key_segment(self):
        provider = TheMealDBRecipeProvider()
        provider.api_key = "1"
        self.urls = []
        with mock.patch("urllib.request.urlopen", self._urlopen):
            try:
                provider._get("filter", {"i": "egg"})
            except OSError:
                pass
        self.assertEqual(
            self.urls[0],
            "https://www.themealdb.com/api/json/v1/1/filter.php?i=egg",
        )

    def test_lookup_url_has_single_key_segment(self):
        provider = TheMealDBRecipeProvider()
        provider.api_key = "1"
        self.urls = []
        with mock.patch("urllib.request.urlopen", self._urlopen):
            try:
                provider._get("lookup", {"i": "52772"})
            except OSError:
                pass
        self.assertEqual(
            self.urls[0],
            "https://www.themealdb.com/api/json/v1/1/lookup.php?i=52772",
        )

    def test_key_not_duplicated_in_query_string(self):
        # The old code injected `_=1` into the query string AND the path.
        # Ensure the query string carries only the real params.
        provider = TheMealDBRecipeProvider()
        provider.api_key = "1"
        self.urls = []
        with mock.patch("urllib.request.urlopen", self._urlopen):
            try:
                provider._get("filter", {"i": "egg"})
            except OSError:
                pass
        self.assertNotIn("_=1", self.urls[0])
        self.assertIn("?i=egg", self.urls[0])


class TestTheMealDBProviderSearch(unittest.TestCase):
    """End-to-end search with mocked filter + lookup responses."""

    def _run_search(self, provider, filter_payload, lookup_map):
        """Mock _get so filter.php returns filter_payload and lookup.php
        returns the mapped detail for each candidate id."""
        def fake_get(endpoint, params):
            if endpoint == "filter":
                return filter_payload
            if endpoint == "lookup":
                mid = params.get("i")
                detail = lookup_map.get(mid)
                return {"meals": [detail]} if detail else {"meals": None}
            raise AssertionError(f"unexpected endpoint {endpoint}")
        with mock.patch.object(provider, "_get", side_effect=fake_get):
            return provider.search(["egg"], {})

    def test_search_returns_recipes_with_ingredients(self):
        provider = TheMealDBRecipeProvider()
        filter_payload = {"meals": [
            {"idMeal": "52772", "strMeal": "Egg Pasta", "strMealThumb": ""},
        ]}
        lookup_map = {"52772": _lookup_meal("52772", "Egg Pasta", "Italian",
                                            ["Egg", "Flour", "Olive Oil"])}
        recipes = self._run_search(provider, filter_payload, lookup_map)
        self.assertTrue(recipes)
        r = recipes[0]
        # Ingredients must be present (previous bug: filter.php-only => none).
        self.assertTrue(r["ingredients"])
        names = {i["canonical"] for i in r["ingredients"]}
        self.assertIn("egg", names)
        self.assertIn("flour", names)

    def test_search_stores_no_prose_or_image(self):
        provider = TheMealDBRecipeProvider()
        filter_payload = {"meals": [{"idMeal": "52772", "strMeal": "Egg Pasta"}]}
        lookup_map = {"52772": _lookup_meal("52772", "Egg Pasta", "Italian",
                                            ["Egg", "Flour"])}
        recipes = self._run_search(provider, filter_payload, lookup_map)
        r = recipes[0]
        self.assertEqual(r["instructions"], [])
        self.assertEqual(r["image_url"], "")
        self.assertEqual(r["description"], "")
        # But the source link is preserved for attribution.
        self.assertEqual(r["source_url"], "https://www.themealdb.com/meal/52772")
        self.assertEqual(r["source_name"], "TheMealDB")
        self.assertTrue(r["attribution_text"])

    def test_search_allergens_derived_from_ingredients(self):
        provider = TheMealDBRecipeProvider()
        filter_payload = {"meals": [{"idMeal": "1", "strMeal": "Cheese Toast"}]}
        lookup_map = {"1": _lookup_meal("1", "Cheese Toast", "American",
                                        ["Cheese", "Bread", "Butter"])}
        recipes = self._run_search(provider, filter_payload, lookup_map)
        tags = recipes[0]["allergen_tags"]
        self.assertIn("milk", tags)      # cheese + butter
        self.assertIn("gluten", tags)    # bread
        self.assertNotIn("egg", tags)    # no egg in the ingredient list

    def test_search_deduplicates_meal_ids(self):
        provider = TheMealDBRecipeProvider()
        filter_payload = {"meals": [
            {"idMeal": "1", "strMeal": "A"}, {"idMeal": "1", "strMeal": "A"},
            {"idMeal": "2", "strMeal": "B"},
        ]}
        lookup_map = {
            "1": _lookup_meal("1", "A", "American", ["Egg"]),
            "2": _lookup_meal("2", "B", "American", ["Egg"]),
        }
        recipes = self._run_search(provider, filter_payload, lookup_map)
        self.assertEqual(len(recipes), 2)

    def test_search_ignores_lookup_failures(self):
        provider = TheMealDBRecipeProvider()
        filter_payload = {"meals": [{"idMeal": "1", "strMeal": "A"}]}
        # lookup for id "1" raises -> provider must skip it, return [].
        def fake_get(endpoint, params):
            if endpoint == "filter":
                return filter_payload
            raise OSError("lookup down")
        with mock.patch.object(provider, "_get", side_effect=fake_get):
            recipes = provider.search(["egg"], {})
        self.assertEqual(recipes, [])


class TestTheMealDBProviderResilience(unittest.TestCase):
    def test_filter_timeout_returns_empty(self):
        provider = TheMealDBRecipeProvider()
        with mock.patch.object(provider, "_get", side_effect=TimeoutError("slow")):
            self.assertEqual(provider.search(["egg"], {}), [])

    def test_filter_network_error_returns_empty(self):
        provider = TheMealDBRecipeProvider()
        with mock.patch.object(provider, "_get", side_effect=OSError("down")):
            self.assertEqual(provider.search(["egg"], {}), [])

    def test_malformed_filter_response_returns_empty(self):
        provider = TheMealDBRecipeProvider()
        with mock.patch.object(provider, "_get", return_value={"meals": None}):
            self.assertEqual(provider.search(["egg"], {}), [])

    def test_external_disabled_returns_empty(self):
        provider = TheMealDBRecipeProvider()
        with mock.patch.object(recipe_discovery, "ENABLE_EXTERNAL", False):
            self.assertEqual(provider.search(["egg"], {}), [])

    def test_unknown_ingredient_returns_empty(self):
        # No mappable term => no filter lookups => no recipes, no crash.
        provider = TheMealDBRecipeProvider()
        calls = []
        def fake_get(endpoint, params):
            calls.append((endpoint, params))
            return {"meals": None}
        with mock.patch.object(provider, "_get", side_effect=fake_get):
            recipes = provider.search(["xyzzy unknown"], {})
        self.assertEqual(recipes, [])
        self.assertEqual(calls, [])


class TestAllergenDerivation(unittest.TestCase):
    def test_derive_known_allergens(self):
        self.assertEqual(derive_allergens(["milk", "egg"]), ["egg", "milk"])
        self.assertEqual(derive_allergens(["cheese", "butter"]), ["milk"])
        self.assertEqual(derive_allergens(["shrimp"]), ["shellfish"])

    def test_derive_allergens_no_false_positives(self):
        # Non-dairy / non-gluten lookalikes must not be misclassified.
        self.assertEqual(derive_allergens(["coconut milk"]), [])
        self.assertEqual(derive_allergens(["peanut butter"]), ["peanut"])
        self.assertEqual(derive_allergens(["soy milk"]), ["soy"])
        self.assertEqual(derive_allergens(["almond milk"]), ["tree nut"])
        self.assertEqual(derive_allergens(["swordfish"]), [])
        self.assertEqual(derive_allergens(["eggplant"]), [])

    def test_derive_unknown_ingredient_is_fail_safe(self):
        # Unknown ingredient contributes nothing (never an invented allergen).
        self.assertEqual(derive_allergens(["galangal", "kemiri"]), [])

    def test_derive_empty_input(self):
        self.assertEqual(derive_allergens([]), [])
        self.assertEqual(derive_allergens(None), [])
        self.assertEqual(derive_allergens(["", "  "]), [])

    def test_derive_is_deterministic(self):
        names = ["Egg", "Soy Sauce", "Peanut", "Flour", "Milk"]
        a = derive_allergens(names)
        b = derive_allergens(list(reversed(names)))
        self.assertEqual(a, b)
        self.assertEqual(a, sorted(a))


class TestNormalizeRecipeTime(unittest.TestCase):
    def test_total_minutes_computed_from_prep_cook(self):
        r = normalize_recipe({"id": "x", "prep_minutes": 10, "cook_minutes": 20})
        self.assertEqual(r["total_minutes"], 30)

    def test_total_minutes_prefers_explicit(self):
        r = normalize_recipe({"id": "x", "prep_minutes": 10, "cook_minutes": 20,
                              "total_minutes": 99})
        self.assertEqual(r["total_minutes"], 99)

    def test_total_minutes_none_when_no_time(self):
        r = normalize_recipe({"id": "x"})
        self.assertIsNone(r["total_minutes"])

    def test_total_minutes_handles_zero(self):
        r = normalize_recipe({"id": "x", "prep_minutes": 0, "cook_minutes": 15})
        self.assertEqual(r["total_minutes"], 15)


class TestAllergenFilterFailClosed(unittest.TestCase):
    """An allergen exclusion filter must never let a recipe with an unknown
    (absent) allergen classification slip through as 'safe' when we cannot
    verify it. But it also must not invent allergens. Verify the matching
    layer's behavior with explicit allergen tags."""

    def _recipe(self, tags):
        return {
            "id": "r1", "title": "X", "cuisine": "American",
            "ingredients": [{"canonical": "egg", "optional": False,
                             "pantry_staple": False, "amount": 1, "unit": ""}],
            "allergen_tags": tags,
        }

    def test_exclude_allergen_removes_recipe(self):
        recs = [self._recipe(["milk", "gluten"])]
        out = recipe_discovery.match_recipes(
            recs, ["egg"], {"excludeAllergens": ["milk"]})
        self.assertEqual(out, [])

    def test_no_allergen_tags_but_has_ingredients_kept(self):
        # A recipe with ingredient data and empty allergen tags means we
        # positively derived its allergens and found none matching — a real
        # result, not an unknown, so it is NOT dropped.
        recs = [self._recipe([])]
        out = recipe_discovery.match_recipes(
            recs, ["egg"], {"excludeAllergens": ["peanut"]})
        self.assertEqual(len(out), 1)

    def test_unknown_allergen_metadata_fails_closed(self):
        # A recipe with NO ingredient data is "unknown metadata": with an
        # allergen exclusion in effect it must fail closed (be excluded), not
        # silently pass as safe.
        recs = [{"id": "r1", "title": "X", "cuisine": "American",
                 "ingredients": [], "allergen_tags": []}]
        out = recipe_discovery.match_recipes(
            recs, ["egg"], {"excludeAllergens": ["peanut"]})
        self.assertEqual(out, [])

    def test_no_exclusions_unknown_allergen_still_scores(self):
        # Without an allergen exclusion, a no-ingredient recipe is simply
        # filtered out by the scoring layer (no required ingredients), so it
        # never reaches results anyway — but the filter itself must not crash.
        recs = [{"id": "r1", "title": "X", "cuisine": "American",
                 "ingredients": [], "allergen_tags": []}]
        out = recipe_discovery.match_recipes(recs, ["egg"], {})
        self.assertEqual(out, [])


class TestDeterministicMatching(unittest.TestCase):
    def test_identical_input_identical_output(self):
        recs = [
            {"id": "a", "title": "Nasi Goreng", "cuisine": "Indonesian",
             "verified": True, "diet_tags": [], "allergen_tags": ["egg"],
             "ingredients": [
                 {"canonical": "rice", "optional": False, "pantry_staple": False},
                 {"canonical": "egg", "optional": False, "pantry_staple": False},
             ]},
            {"id": "b", "title": "Beef Stew", "cuisine": "American",
             "verified": False, "diet_tags": [], "allergen_tags": [],
             "ingredients": [
                 {"canonical": "beef", "optional": False, "pantry_staple": False},
             ]},
        ]
        args = (recs, ["telur", "nasi"])
        a = recipe_discovery.match_recipes(*args)
        b = recipe_discovery.match_recipes(*args)
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main(verbosity=2)

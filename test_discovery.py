"""Tests for the deterministic recipe discovery backend.

Covers:
- ingredient normalization (multilingual aliases + pantry detection)
- deterministic matching (scoring, ranking, no unrelated results)
- seed catalog integrity (original international recipes)
- preference filters (cuisine/diet/time)
- Supabase adapter behavior without credentials (offline)
- server.py run_discovery integration (no network)

No paid API calls. Network-dependent providers are either skipped or
monkeypatched to empty. Tests import stdlib-only modules.
"""
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import ingredients
import recipe_discovery
import seed_data
import supabase_client


class TestIngredientNormalization(unittest.TestCase):
    def test_canonicalize_indonesian_to_english(self):
        self.assertEqual(ingredients.canonicalize("Bawang Putih"), "garlic")
        self.assertEqual(ingredients.canonicalize("telur"), "egg")
        self.assertEqual(ingredients.canonicalize("daging sapi"), "beef")
        self.assertEqual(ingredients.canonicalize("kecap manis"), "sweet soy sauce")

    def test_canonicalize_case_and_whitespace_insensitive(self):
        self.assertEqual(ingredients.canonicalize("  TELUR  "), "egg")
        self.assertEqual(ingredients.canonicalize("Nasi"), "rice")

    def test_canonicalize_unknown_stays_lowercase(self):
        # Unknown terms are lowercased; known stopwords (e.g. "buah") stripped.
        self.assertEqual(ingredients.canonicalize("buah naga asing"), "naga asing")
        self.assertEqual(ingredients.canonicalize("XYZ UNKNOWN"), "xyz unknown")

    def test_normalize_ingredients_dedupes(self):
        out = ingredients.normalize_ingredients(["telur", "Telur", "egg"])
        self.assertEqual(out, ["egg"])

    def test_pantry_detection(self):
        # is_pantry operates on the canonical form
        self.assertTrue(ingredients.is_pantry("salt"))
        self.assertTrue(ingredients.is_pantry("sugar"))
        self.assertFalse(ingredients.is_pantry("chicken"))
        # canonicalize first for Indonesian input
        self.assertTrue(ingredients.is_pantry(ingredients.canonicalize("garam")))


class TestDeterministicMatching(unittest.TestCase):
    def setUp(self):
        self.catalog = seed_data.seed_recipe_catalog()

    def test_match_returns_ranked_results(self):
        matches = recipe_discovery.match_recipes(
            self.catalog, ["telur", "nasi", "bawang putih", "kecap manis"]
        )
        self.assertTrue(matches)
        # scores descending
        scores = [m["matchScore"] for m in matches]
        self.assertEqual(scores, sorted(scores, reverse=True))
        # top result should be nasi goreng (rice + egg + garlic + sweet soy)
        self.assertIn("nasi goreng", matches[0]["title"].lower())

    def test_match_no_unrelated_results(self):
        # Unrelated ingredient -> no recipe should match with a high score
        matches = recipe_discovery.match_recipes(self.catalog, ["stroberi", "vanilla"])
        # either empty, or every result shares at least one ingredient
        for m in matches:
            self.assertTrue(m["matchedIngredients"])

    def test_match_score_bounded(self):
        matches = recipe_discovery.match_recipes(
            self.catalog, ["telur", "nasi", "bawang putih"]
        )
        for m in matches:
            self.assertGreaterEqual(m["matchScore"], 0.0)
            self.assertLessEqual(m["matchScore"], 1.0)

    def test_match_reports_missing_and_unused(self):
        matches = recipe_discovery.match_recipes(
            self.catalog, ["telur", "nasi", "bawang putih"]
        )
        self.assertTrue(matches)
        m = matches[0]
        self.assertIsInstance(m["missingIngredients"], list)
        self.assertIsInstance(m["unusedIngredients"], list)
        self.assertIsInstance(m["matchedIngredients"], list)
        self.assertIn("egg", m["matchedIngredients"])
        self.assertIn("rice", m["matchedIngredients"])

    def test_cuisine_filter(self):
        all_matches = recipe_discovery.match_recipes(
            self.catalog, ["nasi", "ayam", "santan"], {"cuisines": ["indonesian"]}
        )
        for m in all_matches:
            self.assertEqual(m["cuisine"].lower(), "indonesian")

    def test_diet_filter(self):
        matches = recipe_discovery.match_recipes(
            self.catalog, ["nasi", "sayuran", "tahu"], {"diet": ["vegetarian"]}
        )
        for m in matches:
            self.assertTrue(any("vegetarian" in d or "vegan" in d for d in m["diet_tags"]))

    def test_max_time_filter(self):
        matches = recipe_discovery.match_recipes(
            self.catalog, ["nasi", "ayam"], {"maxTimeMinutes": 20}
        )
        for m in matches:
            total = m.get("total_minutes") or (
                (m.get("prep_minutes") or 0) + (m.get("cook_minutes") or 0)
            )
            if total:
                self.assertLessEqual(total, 20)


class TestSeedCatalog(unittest.TestCase):
    def setUp(self):
        self.catalog = seed_data.seed_recipe_catalog()

    def test_seed_has_multiple_cuisines(self):
        cuisines = {r["cuisine"].lower() for r in self.catalog}
        # International seed data must span several cuisines
        self.assertGreaterEqual(len(cuisines), 5)

    def test_seed_recipes_have_required_fields(self):
        for r in self.catalog:
            self.assertTrue(r.get("id"))
            self.assertTrue(r.get("title"))
            self.assertTrue(r.get("cuisine"))
            self.assertTrue(r.get("ingredients"))
            self.assertTrue(r.get("instructions"))
            self.assertIn(r.get("source_type"), ("curated", "seed", "original"))

    def test_seed_ids_unique(self):
        ids = [r["id"] for r in self.catalog]
        self.assertEqual(len(ids), len(set(ids)))

    def test_seed_ingredients_have_canonical(self):
        for r in self.catalog:
            for ing in r["ingredients"]:
                self.assertIn("canonical", ing)

    def test_normalize_recipe_adds_total_minutes(self):
        nr = recipe_discovery.normalize_recipe(self.catalog[0])
        self.assertIn("total_minutes", nr)


class TestSupabaseAdapter(unittest.TestCase):
    def test_unconfigured_client(self):
        # With no env vars, client must report not-configured and return
        # empty results without raising.
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SUPABASE_URL", None)
            os.environ.pop("SUPABASE_ANON_KEY", None)
            import importlib
            importlib.reload(supabase_client)
            self.assertFalse(supabase_client.is_configured())
            self.assertEqual(supabase_client.fetch_verified_recipes(), [])


class TestServerIntegration(unittest.TestCase):
    def test_run_discovery_returns_recipes(self):
        # Import server module with stubbed optional deps (mirrors existing
        # test_recommendation.py).
        import importlib.util
        sys.modules.setdefault("win32crypt", mock.MagicMock())
        ks = mock.MagicMock()
        ks.load_key.return_value = ""
        sys.modules["key_store"] = ks
        _real_rs = sys.modules.get("recipe_sources")
        rs = mock.MagicMock()
        rs.mixed_recipes = lambda *a, **k: []
        sys.modules["recipe_sources"] = rs

        spec = importlib.util.spec_from_file_location(
            "server_under_test", os.path.join(HERE, "server.py")
        )
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        try:
            # Disable external providers so only seed catalog is used (no network).
            with mock.patch.object(recipe_discovery, "ENABLE_EXTERNAL", False):
                result = server.run_discovery(["telur", "nasi", "bawang putih"])
        finally:
            if _real_rs is not None:
                sys.modules["recipe_sources"] = _real_rs
            else:
                sys.modules.pop("recipe_sources", None)
        self.assertIn("recipes", result)
        self.assertTrue(result["recipes"])
        self.assertIn("fallback", result)
        self.assertIn("source", result)
        self.assertIn("detected_ingredients", result)

    def test_normalize_preferences_mapping(self):
        import importlib.util
        sys.modules.setdefault("win32crypt", mock.MagicMock())
        ks = mock.MagicMock()
        ks.load_key.return_value = ""
        sys.modules["key_store"] = ks
        _real_rs = sys.modules.get("recipe_sources")
        rs = mock.MagicMock()
        rs.mixed_recipes = lambda *a, **k: []
        sys.modules["recipe_sources"] = rs
        spec = importlib.util.spec_from_file_location(
            "server_under_test_2", os.path.join(HERE, "server.py")
        )
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        try:
            out = server._normalize_preferences(
                {"cuisine": "indonesian", "diet": "vegan", "maxTimeMinutes": 30}
            )
        finally:
            if _real_rs is not None:
                sys.modules["recipe_sources"] = _real_rs
            else:
                sys.modules.pop("recipe_sources", None)
        self.assertEqual(out["cuisines"], ["indonesian"])
        self.assertEqual(out["diet"], ["vegan"])
        self.assertEqual(out["maxTimeMinutes"], 30)


if __name__ == "__main__":
    unittest.main(verbosity=2)

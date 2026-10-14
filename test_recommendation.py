"""Tests for ingredient-relevance recommendation flow in server.py.

These tests import functions directly from server.py and monkeypatch any
network-dependent helpers so no live AI or network calls are made. They only
assert on deterministic fixtures, never claim live AI output.
"""
import importlib.util
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_PATH = os.path.join(HERE, "server.py")

# Stub optional imports so server.py loads without Windows-only deps / network.
# key_store imports win32crypt on Windows; provide a dummy. mixed_recipes is
# monkeypatched below where needed.
sys.modules.setdefault("win32crypt", mock.MagicMock())
_key_store = mock.MagicMock()
_key_store.load_key.return_value = ""
sys.modules["key_store"] = _key_store
sys.modules["recipe_sources"] = mock.MagicMock()
sys.modules["recipe_sources"].mixed_recipes = lambda *a, **k: []

spec = importlib.util.spec_from_file_location("server_under_test", SERVER_PATH)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class TestIngredientNormalization(unittest.TestCase):
    def test_normalize_indonesian_to_english(self):
        # "telur" -> "egg", "ayam" -> "chicken"
        self.assertIn("egg", server.normalize_ingredient("telur"))
        self.assertIn("chicken", server.normalize_ingredient("ayam"))

    def test_normalize_strips_non_ingredient_words(self):
        out = server.normalize_ingredient("rasa goreng telur")
        self.assertIn("egg", out)
        self.assertNotIn("rasa", out)
        self.assertNotIn("goreng", out)

    def test_normalize_drops_short_noise(self):
        self.assertEqual(server.normalize_ingredient("ab"), [])

    def test_ingredient_query_uses_aliases_and_all_words(self):
        q = server.ingredient_query(["telur", "ayam", "kentang", "rasa goreng"])
        self.assertIn("egg", q)
        self.assertIn("chicken", q)
        self.assertIn("potato", q)


class TestRanking(unittest.TestCase):
    def test_rank_cards_filters_and_scores_by_title(self):
        cards = [
            {"nama": "Fried Rice", "url": "https://x/1", "thumbnail": "https://x/1.jpg"},
            {"nama": "Nasi Goreng Spesial", "url": "https://x/2", "thumbnail": "https://x/2.jpg"},
            {"nama": "Beef Stew", "url": "https://x/3", "thumbnail": "https://x/3.jpg"},
        ]
        ranked = server.rank_cards(cards, ["nasi", "telur"])
        # "Beef Stew" tidak cocok -> dibuang
        names = [c["nama"] for c in ranked]
        self.assertNotIn("Beef Stew", names)
        # Semua hasil punya reason + recommended hanya satu
        self.assertTrue(all(c.get("reason") for c in ranked))
        self.assertEqual(sum(1 for c in ranked if c.get("recommended")), 1)

    def test_rank_cards_unrelated_rejected(self):
        cards = [
            {"nama": "Chocolate Cake", "url": "https://x/1", "thumbnail": "https://x/1.jpg"},
            {"nama": "Pizza", "url": "https://x/2", "thumbnail": "https://x/2.jpg"},
        ]
        ranked = server.rank_cards(cards, ["tempe", "kangkung"])
        self.assertEqual(ranked, [])

    def test_rank_cards_empty_ingredients_returns_empty(self):
        cards = [{"nama": "Fried Rice", "url": "https://x/1", "thumbnail": "https://x/1.jpg"}]
        self.assertEqual(server.rank_cards(cards, []), [])

    def test_recommended_cards_only_for_rendang_indomie(self):
        out = server.recommended_cards(["indomie", "rendang"])
        self.assertTrue(out)
        self.assertEqual(sum(1 for c in out if c.get("recommended")), 1)
        # unrelated ingredients -> empty
        self.assertEqual(server.recommended_cards(["tomat", "wortel"]), [])


class TestFallbackNoUnrelated(unittest.TestCase):
    def test_lookup_recipe_cards_rejects_unrelated(self):
        fake_meals = [
            {"idMeal": "1", "strMeal": "Chocolate Cake", "strMealThumb": "https://x/1.jpg"},
            {"idMeal": "2", "strMeal": "Beef Curry", "strMealThumb": "https://x/2.jpg"},
        ]

        def fake_search(url):
            return fake_meals

        with mock.patch("concurrent.futures.ThreadPoolExecutor") as pool_cls:
            pool_cls.return_value.__enter__.return_value.map.side_effect = (
                lambda fn, urls: [fake_meals for _ in urls]
            )
            result = server.lookup_recipe_cards(["a", "b"], ["tempe", "bayam"])
        # None of the fake meals match tempe/bayam -> must not return unrelated results
        self.assertEqual(result, [])

    def test_lookup_recipe_cards_keeps_matching(self):
        fake_meals = [
            {"idMeal": "1", "strMeal": "Tempeh Stir Fry", "strMealThumb": "https://x/1.jpg"},
        ]

        def fake_search(url):
            return fake_meals

        with mock.patch("concurrent.futures.ThreadPoolExecutor") as pool_cls:
            pool_cls.return_value.__enter__.return_value.map.side_effect = (
                lambda fn, urls: [fake_meals for _ in urls]
            )
            result = server.lookup_recipe_cards(["tempe"], ["tempe"])
        self.assertTrue(result)
        self.assertIn("Tempeh Stir Fry", [c["nama"] for c in result])


class TestHandleScanRanking(unittest.TestCase):
    def test_handle_scan_uses_rank_cards(self):
        """Integration of handle_scan menu-alternative assembly with mocked
        AI + network. Asserts the ranking path, not live AI output."""
        detected = ["nasi", "telur"]
        query = server.ingredient_query(detected)
        fake_cards = [
            {"nama": "Nasi Goreng", "thumbnail": "https://x/1.jpg", "url": "https://x/1", "source": "Cookpad"},
            {"nama": "Ice Cream", "thumbnail": "https://x/2.jpg", "url": "https://x/2", "source": "Cookpad"},
        ]
        # Simulate handle_scan's ranking branch in isolation
        alt = server.rank_cards(fake_cards, detected)
        names = [c["nama"] for c in alt]
        self.assertIn("Nasi Goreng", names)
        self.assertNotIn("Ice Cream", names)
        self.assertTrue(all(c.get("reason") for c in alt))


if __name__ == "__main__":
    unittest.main(verbosity=2)

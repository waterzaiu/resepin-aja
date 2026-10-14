"""Security tests for recipe_sources.py.

These tests exercise the hardening added to the legacy scraping module:
bounded cache (TTL + max entries), disabled-by-default scraping, hostname
allowlists, graceful failure, and the parser fixtures. All network access is
mocked via ``recipe_sources._fetch`` so no real quota or outbound request is
ever made.
"""

import os
import threading
import unittest
from unittest import mock

import recipe_sources as rs


ALLRECIPES_HTML = """<html><body>
<a href="https://www.allrecipes.com/recipe/12345/garlic-chicken/"><span class="card__title-text">Garlic Chicken</span><img data-src="https://www.allrecipes.com/thmb/abc.jpg"></a>
<a href="https://www.allrecipes.com/recipe/67890/beef-stew/"><span class="card__title-text">Beef Stew</span><img data-src="https://www.allrecipes.com/thmb/def.jpg"></a>
</body></html>"""

ALLRECIPES_BAD_THUMB = """<html><body>
<a href="https://www.allrecipes.com/recipe/11111/evil/"><span class="card__title-text">Evil</span><img data-src="https://evil.example.com/x.jpg"></a>
</body></html>"""

DETIK_HTML = """<html><body>
<article i-link="https://food.detik.com/resep/d-12345/ayam-goreng" i-img="https://akcdn.detik.net.id/ayam.jpg"></article>
<article i-link="https://food.detik.com/resep/d-67890/soto-betawi" i-img="https://akcdn.detik.net.id/soto.jpg"></article>
</body></html>"""

DETIK_BAD_LINK = """<html><body>
<article i-link="https://evil.example.com/resep/d-1/x" i-img="https://akcdn.detik.net.id/x.jpg"></article>
</body></html>"""


def _card(url, thumb, nama="Test", source="Cookpad"):
    return {"nama": nama, "thumbnail": thumb, "url": url, "source": source}


class FeatureFlagTests(unittest.TestCase):
    def setUp(self):
        self.orig = os.environ.get("RECIPE_SCRAPING_ENABLED")
        # Save and force the module flag off to test disabled-by-default.
        os.environ.pop("RECIPE_SCRAPING_ENABLED", None)
        rs.SCRAPING_ENABLED = False

    def tearDown(self):
        rs.SCRAPING_ENABLED = bool(os.environ.get("RECIPE_SCRAPING_ENABLED", "").strip())
        if self.orig is None:
            os.environ.pop("RECIPE_SCRAPING_ENABLED", None)
        else:
            os.environ["RECIPE_SCRAPING_ENABLED"] = self.orig

    def test_scrapers_return_empty_when_disabled(self):
        with mock.patch.object(rs, "_fetch") as fetch:
            self.assertEqual(rs.search_allrecipes("ayam"), [])
            self.assertEqual(rs.search_detik("ayam"), [])
            fetch.assert_not_called()

    def test_mixed_recipes_never_invokes_cookpad_callback_when_disabled(self):
        # Regression: the server-side search_cookpad scrapes Cookpad, so the
        # caller-supplied callback must NOT fire unless scraping is enabled.
        calls = {"n": 0}

        def cookpad(q, limit):
            calls["n"] += 1
            return [_card("https://food.detik.com/resep/d-1/x", "https://akcdn.detik.net.id/x.jpg")]

        with mock.patch.object(rs, "_fetch") as fetch:
            out = rs.mixed_recipes("ayam", cookpad, limit=5)
        fetch.assert_not_called()
        self.assertEqual(calls["n"], 0)
        self.assertEqual(out, [])

    def test_scrapers_fetch_when_enabled(self):
        rs.SCRAPING_ENABLED = True
        with mock.patch.object(rs, "_fetch", return_value=ALLRECIPES_HTML) as fetch:
            out = rs.search_allrecipes("ayam")
        fetch.assert_called_once()
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["nama"], "Garlic Chicken")


class HostnameAllowlistTests(unittest.TestCase):
    def test_host_allowed_exact(self):
        self.assertTrue(rs._host_allowed("https://food.detik.com/resep/d-1/x", rs._ALLOWED_RESULT_HOSTS))

    def test_host_allowed_subdomain(self):
        self.assertTrue(rs._host_allowed("https://www.allrecipes.com/recipe/1/x", rs._ALLOWED_RESULT_HOSTS))

    def test_host_allowed_rejects_wrong_host(self):
        self.assertFalse(rs._host_allowed("https://evil.example.com/x", rs._ALLOWED_RESULT_HOSTS))

    def test_host_allowed_rejects_bad_suffix(self):
        # Not-a-suffix: "allrecipes.com.evil" must not match "allrecipes.com".
        self.assertFalse(rs._host_allowed("https://allrecipes.com.evil.com/x", rs._ALLOWED_RESULT_HOSTS))

    def test_host_allowed_rejects_empty_and_garbage(self):
        self.assertFalse(rs._host_allowed("", rs._ALLOWED_RESULT_HOSTS))
        self.assertFalse(rs._host_allowed("not a url", rs._ALLOWED_RESULT_HOSTS))

    def test_thumbnail_allowlist_separate(self):
        self.assertTrue(rs._host_allowed("https://akcdn.detik.net.id/x.jpg", rs._ALLOWED_THUMBNAIL_HOSTS))
        self.assertFalse(rs._host_allowed("https://food.detik.com/x.jpg", rs._ALLOWED_THUMBNAIL_HOSTS))


class ParserFixtureTests(unittest.TestCase):
    def test_allrecipes_parser_parses_cards(self):
        parser = rs._Allrecipes()
        parser.feed(ALLRECIPES_HTML)
        self.assertEqual(len(parser.cards), 2)
        self.assertEqual(parser.cards[0]["nama"], "Garlic Chicken")
        self.assertEqual(parser.cards[0]["source"], "Allrecipes")

    def test_detik_parser_parses_cards(self):
        parser = rs._Detik()
        parser.feed(DETIK_HTML)
        self.assertEqual(len(parser.cards), 2)
        self.assertEqual(parser.cards[0]["source"], "detikFood")
        self.assertTrue(parser.cards[0]["url"].startswith("https://food.detik.com/"))

    def test_allrecipes_drops_disallowed_thumbnail(self):
        rs.SCRAPING_ENABLED = True
        with mock.patch.object(rs, "_fetch", return_value=ALLRECIPES_BAD_THUMB):
            out = rs.search_allrecipes("ayam")
        self.assertEqual(out, [])  # thumbnail host not allowlisted -> dropped

    def test_detik_drops_disallowed_link(self):
        rs.SCRAPING_ENABLED = True
        with mock.patch.object(rs, "_fetch", return_value=DETIK_BAD_LINK):
            out = rs.search_detik("ayam")
        self.assertEqual(out, [])  # result host not allowlisted -> dropped


class MixedRecipesAllowlistTests(unittest.TestCase):
    def setUp(self):
        self._saved_cache = rs._CACHE
        rs._CACHE = {}
        os.environ.pop("RECIPE_SCRAPING_ENABLED", None)
        rs.SCRAPING_ENABLED = False

    def tearDown(self):
        rs._CACHE = self._saved_cache
        rs.SCRAPING_ENABLED = bool(os.environ.get("RECIPE_SCRAPING_ENABLED", "").strip())

    def test_mixed_drops_non_allowlisted_cookpad_card(self):
        rs.SCRAPING_ENABLED = True

        def cookpad(q, limit):
            return [
                _card("https://food.detik.com/resep/d-1/ok", "https://akcdn.detik.net.id/ok.jpg"),
                _card("https://evil.example.com/x", "https://evil.example.com/x.jpg"),
            ]

        with mock.patch.object(rs, "_fetch", return_value=""):
            out = rs.mixed_recipes("ayam", cookpad, limit=5)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["url"], "https://food.detik.com/resep/d-1/ok")


class BoundedCacheTests(unittest.TestCase):
    def setUp(self):
        self._saved_cache = rs._CACHE
        self._saved_ttl = rs._CACHE_TTL_SECONDS
        rs._CACHE = {}

    def tearDown(self):
        rs._CACHE = self._saved_cache
        rs._CACHE_TTL_SECONDS = self._saved_ttl

    def test_cache_hit_returns_copy(self):
        key = ("test", 5)
        rs._cache_put(key, [_card("https://food.detik.com/resep/d-1/x", "https://akcdn.detik.net.id/x.jpg")])
        out = rs._cache_get(key)
        self.assertEqual(len(out), 1)
        out[0]["nama"] = "mutated"
        again = rs._cache_get(key)
        self.assertEqual(again[0]["nama"], "Test")  # copy, not shared ref

    def test_expired_entry_is_evicted(self):
        key = ("expired", 5)
        with mock.patch.object(rs.time, "monotonic", return_value=1000.0):
            with rs._LOCK:
                rs._CACHE[key] = (100.0, [dict()])  # 900s ago > TTL (600)
            self.assertIsNone(rs._cache_get(key))
            self.assertNotIn(key, rs._CACHE)

    def test_max_entries_cap_evicts_oldest(self):
        old_max = rs._CACHE_MAX_ENTRIES
        rs._CACHE_MAX_ENTRIES = 3
        try:
            for i in range(5):
                rs._cache_put(("k%d" % i, 1), [dict()])
            self.assertLessEqual(len(rs._CACHE), 3)
        finally:
            rs._CACHE_MAX_ENTRIES = old_max

    def test_mixed_recipes_uses_cache_on_second_call(self):
        calls = {"n": 0}

        def cookpad(q, limit):
            calls["n"] += 1
            return [_card("https://food.detik.com/resep/d-1/x", "https://akcdn.detik.net.id/x.jpg")]

        rs.SCRAPING_ENABLED = True
        with mock.patch.object(rs, "_fetch", return_value=""):
            first = rs.mixed_recipes("cacheme", cookpad, limit=5)
            second = rs.mixed_recipes("cacheme", cookpad, limit=5)
        self.assertEqual(calls["n"], 1)
        self.assertEqual(first, second)


class GracefulFailureTests(unittest.TestCase):
    def setUp(self):
        self._saved_cache = rs._CACHE
        rs._CACHE = {}
        os.environ.pop("RECIPE_SCRAPING_ENABLED", None)
        rs.SCRAPING_ENABLED = False

    def tearDown(self):
        rs._CACHE = self._saved_cache
        rs.SCRAPING_ENABLED = bool(os.environ.get("RECIPE_SCRAPING_ENABLED", "").strip())

    def test_fetch_oserror_returns_empty(self):
        rs.SCRAPING_ENABLED = True
        with mock.patch.object(rs, "_fetch", side_effect=OSError("boom")):
            self.assertEqual(rs.search_allrecipes("ayam"), [])
            self.assertEqual(rs.search_detik("ayam"), [])

    def test_mixed_recipes_survives_cookpad_exception(self):
        def cookpad(q, limit):
            raise RuntimeError("boom")

        rs.SCRAPING_ENABLED = True
        with mock.patch.object(rs, "_fetch", return_value=""):
            out = rs.mixed_recipes("ayam", cookpad, limit=5)
        self.assertEqual(out, [])


if __name__ == "__main__":
    unittest.main()

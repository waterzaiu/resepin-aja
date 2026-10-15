"""Offline regressions; mocked transports are not live-provider evidence."""
import io
import unittest
from unittest import mock

from test_recommendation import server
import recipe_discovery as discovery


class PreviewPolicyTests(unittest.TestCase):
    def test_blob_images_allowed_without_widening_other_directives(self):
        handler = object.__new__(server.Handler)
        handler.send_response = mock.Mock()
        handler.send_header = mock.Mock()
        handler.end_headers = mock.Mock()
        handler.wfile = io.BytesIO()
        handler.serve_html()
        headers = dict(call.args for call in handler.send_header.call_args_list)
        directives = dict(
            (parts[0], parts[1:])
            for directive in headers['Content-Security-Policy'].split(';')
            if (parts := directive.split())
        )
        self.assertEqual(set(directives['img-src']), {"'self'", 'data:', 'https:', 'blob:'})
        self.assertEqual(directives['default-src'], ["'self'"])
        self.assertEqual(directives['connect-src'], ["'self'"])
        self.assertEqual(directives['object-src'], ["'none'"])
        for name, sources in directives.items():
            if name != 'img-src':
                self.assertNotIn('blob:', sources)


class GalleryRegressionTests(unittest.TestCase):
    def test_unfiltered_gallery_keeps_official_cards(self):
        meals = [{'idMeal': '1', 'strMeal': 'Chicken Curry',
                  'strMealThumb': 'https://www.themealdb.com/images/meal.jpg'}]
        with mock.patch('concurrent.futures.ThreadPoolExecutor') as pool:
            pool.return_value.__enter__.return_value.map.return_value = [meals]
            cards = server.lookup_recipe_cards(['Chicken'])
        self.assertEqual(len(cards), 1)

    def test_legacy_search_falls_back_without_enabling_scraping(self):
        handler = object.__new__(server.Handler)
        handler.path = '/api/resep?q=ayam'
        handler._host_allowed = lambda: True
        handler.send_json = mock.Mock()
        with mock.patch.object(server, 'mixed_recipes', return_value=[]), \
                mock.patch.object(server, 'lookup_recipe_cards', return_value=[{'nama': 'Chicken'}]) as lookup:
            handler.do_GET()
        self.assertTrue(handler.send_json.call_args.args[0]['recipes'])
        lookup.assert_called_once()

    def test_catalog_search_matches_ingredient_alias(self):
        self.assertTrue(server.search_discovery('bawang putih'))


class DiscoveryTimeoutTests(unittest.TestCase):
    def test_expired_budget_never_opens_connection(self):
        provider = discovery.TheMealDBRecipeProvider()
        provider._deadline = 10
        with mock.patch.object(discovery.time, 'monotonic', return_value=11), \
                mock.patch.object(discovery.urllib.request, 'urlopen') as transport:
            with self.assertRaises(TimeoutError):
                provider._get('filter', {'i': 'egg'})
        transport.assert_not_called()

    def test_external_opt_out_applies_to_gallery(self):
        with mock.patch.object(discovery, 'ENABLE_EXTERNAL', False), \
                mock.patch.object(server.urllib.request, 'urlopen') as transport:
            self.assertEqual(server.lookup_recipe_cards(['Chicken']), [])
        transport.assert_not_called()

    def test_shared_budget_stops_repeated_timeouts(self):
        provider = discovery.TheMealDBRecipeProvider()
        with mock.patch.object(discovery, 'ENABLE_EXTERNAL', True), \
                mock.patch.object(discovery, 'TIMEOUT_SECONDS', 0.01), \
                mock.patch.object(discovery.time, 'monotonic', return_value=100), \
                mock.patch.object(discovery.urllib.request, 'urlopen', side_effect=TimeoutError) as transport:
            provider.search(['egg', 'chicken', 'rice', 'potato', 'tomato'])
        self.assertEqual(transport.call_count, 1)


if __name__ == '__main__':
    unittest.main()

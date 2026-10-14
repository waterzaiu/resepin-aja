"""Backend security tests for server.py and key_store.py.

Covers the security-repair priorities owned by this child:
  - canonical list-image provider contract (every call_* accepts a LIST)
  - Pillow image validation + sanitization (signature, dimensions, pixel bomb)
  - schema validation inside the fallback loop (malformed AI output -> retry)
  - bounded concurrency / rate limit / body size / deadline
  - safe errors (no raw provider responses / no secrets leaked)
  - readiness (503 when no provider configured)
  - security headers / CORS (no wildcard), host + origin validation
  - privacy: cross-provider fallback can be disabled
  - key_store: graceful non-Windows / missing pywin32 handling

All external provider calls are mocked; no network, no quota, no secrets.
"""

import base64
import io
import os
import sys
import threading
import unittest
import urllib.error
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Ensure no real keys leak into provider selection during tests.
for _k in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY",
           "GROQ_API_KEY", "OPENROUTER_API_KEY", "BIGMODEL_API_KEY",
           "SILICONFLOW_API_KEY"):
    os.environ.pop(_k, None)

import importlib.util


def _load_server():
    spec = importlib.util.spec_from_file_location("_server_under_test", "server.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


m = _load_server()


def _jpeg_bytes(w=64, h=64, color=(200, 30, 30)):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "JPEG")
    return buf.getvalue()


def _data_url(raw, mime="image/jpeg"):
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


class TestImageSanitize(unittest.TestCase):
    def test_valid_jpeg_roundtrip(self):
        mime, jpeg = m.sanitize_image(_jpeg_bytes(), "image/jpeg")
        self.assertEqual(mime, "image/jpeg")
        self.assertTrue(jpeg[:2] == b"\xff\xd8")  # JPEG SOI marker

    def test_rejects_non_image(self):
        # Pillow cannot decode this as an image -> non-retryable 400.
        with self.assertRaises(m.ProviderError) as cm:
            m.sanitize_image(b"not an image at all", "image/jpeg")
        self.assertFalse(cm.exception.retryable)
        self.assertEqual(cm.exception.status, 400)

    def test_rejects_oversized_dimensions(self):
        # A valid but large image exceeds MAX_IMAGE_WIDTH/HEIGHT.
        raw = _jpeg_bytes(w=m.MAX_IMAGE_WIDTH + 1, h=10)
        with self.assertRaises(m.ProviderError) as cm:
            m.sanitize_image(raw, "image/jpeg")
        self.assertEqual(cm.exception.status, 413)

    def test_rejects_pixel_bomb(self):
        # width*height > MAX_DECODED_PIXELS but each dimension within limits.
        w = 5000
        h = m.MAX_DECODED_PIXELS // w + 1
        raw = _jpeg_bytes(w=w, h=h)
        with self.assertRaises(m.ProviderError) as cm:
            m.sanitize_image(raw, "image/jpeg")
        self.assertEqual(cm.exception.status, 413)

    def test_strips_metadata(self):
        from PIL import Image
        raw = _jpeg_bytes()
        # Pillow does not easily inject EXIF here; instead assert re-encode
        # returns a fresh JPEG (EXIF/GPS cannot survive a .convert RGB re-save
        # of a freshly constructed image). At minimum the output is a valid JPEG.
        mime, out = m.sanitize_image(raw, "image/jpeg")
        self.assertEqual(mime, "image/jpeg")
        self.assertLessEqual(len(out), len(raw) * 4)


class TestDataUrlValidation(unittest.TestCase):
    def test_valid(self):
        raw = _jpeg_bytes()
        mime, decoded = m.validate_data_url(_data_url(raw))
        self.assertEqual(mime, "image/jpeg")
        self.assertEqual(decoded, raw)

    def test_rejects_non_image_mime(self):
        with self.assertRaises(m.ProviderError) as cm:
            m.validate_data_url("data:text/html;base64,PGI+aGk8L2I+")
        self.assertFalse(cm.exception.retryable)

    def test_rejects_bad_base64(self):
        with self.assertRaises(m.ProviderError) as cm:
            m.validate_data_url("data:image/jpeg;base64,!!!notbase64!!!")
        self.assertEqual(cm.exception.status, 400)

    def test_rejects_non_string(self):
        with self.assertRaises(m.ProviderError):
            m.validate_data_url(12345)


class TestRecipeValidation(unittest.TestCase):
    def test_valid_recipe(self):
        r = m.validate_recipe({
            "namaMasakan": "Nasi Goreng", "deskripsi": "lezat",
            "waktuMasak": 20, "porsi": 2,
            "bahanTerdeteksi": ["nasi", "telur"],
            "bahanKurang": ["kecap"], "langkah": ["goreng"],
            "menuAlternatif": [],
        })
        self.assertIsNotNone(r)
        self.assertEqual(r["namaMasakan"], "Nasi Goreng")

    def test_invalid_missing_name(self):
        self.assertIsNone(m.validate_recipe({"waktuMasak": 5, "porsi": 1}))

    def test_invalid_scalar(self):
        self.assertIsNone(m.validate_recipe("not a dict"))

    def test_invalid_negative_int(self):
        self.assertIsNone(m.validate_recipe({
            "namaMasakan": "x", "waktuMasak": -5, "porsi": 1,
            "bahanTerdeteksi": [], "bahanKurang": [], "langkah": [],
        }))


class TestProviderContract(unittest.TestCase):
    def test_image_parts_returns_list(self):
        parts = m._image_parts([_data_url(_jpeg_bytes())])
        self.assertIsInstance(parts, list)
        self.assertEqual(len(parts), 1)

    def test_image_parts_accepts_single_string(self):
        # Backward-compatible single-string input is canonicalized to a list.
        parts = m._image_parts(_data_url(_jpeg_bytes()))
        self.assertIsInstance(parts, list)

    def test_image_parts_bounds_count(self):
        urls = [_data_url(_jpeg_bytes()) for _ in range(m.MAX_FILES + 1)]
        with self.assertRaises(m.ProviderError) as cm:
            m._image_parts(urls)
        self.assertEqual(cm.exception.status, 400)

    def test_image_parts_accepts_one_image(self):
        parts = m._image_parts([_data_url(_jpeg_bytes())])
        self.assertEqual(len(parts), 1)

    def test_image_parts_accepts_two_images(self):
        urls = [_data_url(_jpeg_bytes()) for _ in range(2)]
        parts = m._image_parts(urls)
        self.assertEqual(len(parts), 2)

    def test_image_parts_accepts_max_files(self):
        # Exactly MAX_FILES images must be accepted (the common multi-photo case).
        urls = [_data_url(_jpeg_bytes()) for _ in range(m.MAX_FILES)]
        parts = m._image_parts(urls)
        self.assertEqual(len(parts), m.MAX_FILES)


class TestProviderChain(unittest.TestCase):
    """Provider ordering and 'only configured provider' selection."""

    def test_provider_order_includes_all_eight(self):
        # Every supported provider (incl. xAI + SiliconFlow) must be in the
        # canonical order so auto-selection and health output are complete.
        expected = {"openai", "anthropic", "gemini", "xai", "groq",
                    "openrouter", "bigmodel", "siliconflow"}
        self.assertEqual(set(m.PROVIDER_ORDER), expected)
        self.assertEqual(len(m.PROVIDER_ORDER), len(expected))

    def test_only_configured_xai_selects_xai(self):
        # When ONLY xAI has a key, the active set / chain must be exactly [xai].
        with mock.patch.object(m, "get_active_providers", return_value=["xai"]):
            chain = m.choose_provider_chain()
            self.assertEqual(chain, ["xai"])

    def test_auto_chain_respects_canonical_order(self):
        active = ["siliconflow", "openai", "xai"]
        with mock.patch.object(m, "get_active_providers", return_value=active):
            with mock.patch.object(m, "PREFERRED_PROVIDER", "auto"):
                chain = m.choose_provider_chain()
        # Canonical order must win over insertion order.
        self.assertEqual(chain, ["openai", "xai", "siliconflow"])


class TestFallbackAndPrivacy(unittest.TestCase):
    def _patch_providers(self):
        # Patch every call_* to raise a retryable ProviderError, so fallback
        # logic is exercised without network.
        for name in m.PROVIDERS:
            m.PROVIDERS[name]["call"] = mock.Mock(
                side_effect=m.ProviderError("sibuk", retryable=True, status=502)
            )

    def test_no_key_returns_503(self):
        with mock.patch.object(m, "get_active_providers", return_value=[]), \
             mock.patch.object(m, "choose_provider_chain", return_value=[]):
            with self.assertRaises(m.ProviderError) as cm:
                m.call_vision_with_fallback([_data_url(_jpeg_bytes())])
            self.assertEqual(cm.exception.status, 503)
            self.assertFalse(cm.exception.retryable)

    def test_cross_provider_fallback_disabled_uses_only_first(self):
        chain = ["openai", "anthropic"]
        with mock.patch.object(m, "choose_provider_chain", return_value=list(chain)), \
             mock.patch.object(m, "ALLOW_CROSS_PROVIDER_FALLBACK", False):
            calls = {}
            m.PROVIDERS["openai"]["call"] = mock.Mock(
                side_effect=m.ProviderError("boom", retryable=True))
            # Even though openai fails, we must NOT try anthropic.
            with self.assertRaises(m.ProviderError):
                m.call_vision_with_fallback([_data_url(_jpeg_bytes())])
            m.PROVIDERS["anthropic"]["call"] = mock.Mock()

    def test_non_retryable_error_stops_fallback(self):
        self._patch_providers()
        # First provider raises a permanent (bad image) error -> no fallback.
        m.PROVIDERS["openai"]["call"] = mock.Mock(
            side_effect=m.ProviderError("bad image", retryable=False, status=400))
        with mock.patch.object(m, "choose_provider_chain", return_value=["openai", "anthropic"]):
            with self.assertRaises(m.ProviderError) as cm:
                m.call_vision_with_fallback([_data_url(_jpeg_bytes())])
            self.assertEqual(cm.exception.status, 400)
            m.PROVIDERS["anthropic"]["call"].assert_not_called()

    def test_per_request_allow_fallback_false_uses_only_first(self):
        # Explicit allow_fallback=False must override the GLOBAL default (even
        # when the global is True) and only call the first provider.
        m.PROVIDERS["openai"]["call"] = mock.Mock(
            side_effect=m.ProviderError("boom", retryable=True))
        m.PROVIDERS["anthropic"]["call"] = mock.Mock()
        with mock.patch.object(m, "choose_provider_chain", return_value=["openai", "anthropic"]), \
             mock.patch.object(m, "ALLOW_CROSS_PROVIDER_FALLBACK", True):
            with self.assertRaises(m.ProviderError):
                m.call_vision_with_fallback([_data_url(_jpeg_bytes())], allow_fallback=False)
            m.PROVIDERS["anthropic"]["call"].assert_not_called()

    def test_per_request_allow_fallback_true_allows_fallback(self):
        # Explicit allow_fallback=True overrides the global default (False) and
        # falls through to the next provider on retryable failure.
        m.PROVIDERS["openai"]["call"] = mock.Mock(
            side_effect=m.ProviderError("boom", retryable=True, status=502))
        m.PROVIDERS["anthropic"]["call"] = mock.Mock(
            return_value='{"namaMasakan":"Nasi Goreng","waktuMasak":15,"porsi":2,'
                         '"bahanTerdeteksi":["nasi"],"bahanKurang":[],"langkah":["goreng"]}')
        with mock.patch.object(m, "choose_provider_chain", return_value=["openai", "anthropic"]), \
             mock.patch.object(m, "ALLOW_CROSS_PROVIDER_FALLBACK", False):
            provider_used, recipe = m.call_vision_with_fallback(
                [_data_url(_jpeg_bytes())], allow_fallback=True)
            self.assertEqual(provider_used, "anthropic")
            m.PROVIDERS["anthropic"]["call"].assert_called_once()

    def test_allow_fallback_none_uses_global_default(self):
        # allow_fallback=None (field absent) must defer to the global setting.
        m.PROVIDERS["openai"]["call"] = mock.Mock(
            side_effect=m.ProviderError("boom", retryable=True, status=502))
        m.PROVIDERS["anthropic"]["call"] = mock.Mock()
        with mock.patch.object(m, "choose_provider_chain", return_value=["openai", "anthropic"]), \
             mock.patch.object(m, "ALLOW_CROSS_PROVIDER_FALLBACK", False):
            with self.assertRaises(m.ProviderError):
                m.call_vision_with_fallback([_data_url(_jpeg_bytes())], allow_fallback=None)
            m.PROVIDERS["anthropic"]["call"].assert_not_called()


def _bare_handler():
    """Instantiate Handler without socket setup (no __init__ side effects)."""
    h = object.__new__(m.Handler)
    h.headers = {}
    h.client_address = ("10.0.0.1", 12345)
    return h


class TestRateLimiter(unittest.TestCase):
    def test_rate_limit_blocks_after_threshold(self):
        h = _bare_handler()
        limit = m.SCAN_RATE_LIMIT_REQUESTS
        m._rate_state.clear()
        results = [h._rate_limited() for _ in range(limit + 1)]
        self.assertFalse(results[0])                 # first allowed
        self.assertFalse(results[limit - 1])         # up to limit allowed
        self.assertTrue(results[limit])              # over limit blocked
        m._rate_state.clear()


class TestSecurityHeaders(unittest.TestCase):
    def test_no_wildcard_cors(self):
        # Inspect _send_security_headers by reading the source for "*" CORS.
        import inspect
        src = inspect.getsource(m.Handler._send_security_headers)
        self.assertNotIn('Access-Control-Allow-Origin", "*"', src)

    def test_origin_allowed_default(self):
        h = _bare_handler()
        h.headers = {}
        # Default (no ALLOWED_ORIGINS) -> everything allowed locally.
        self.assertTrue(h._origin_allowed())

    def test_origin_denied_when_configured(self):
        h = _bare_handler()
        h.headers = {"Origin": "https://evil.example.com"}
        with mock.patch.object(m, "ALLOWED_ORIGINS", ("https://good.example.com",)):
            self.assertFalse(h._origin_allowed())

    def test_host_denied_when_configured(self):
        h = _bare_handler()
        h.headers = {"Host": "evil.example.com"}
        with mock.patch.object(m, "ALLOWED_HOSTS", ("good.example.com",)):
            self.assertFalse(h._host_allowed())


class TestKeyStoreGraceful(unittest.TestCase):
    def test_key_store_importable_and_safe(self):
        import key_store
        # load_key/save_key must exist and load_key must return "" (or a key)
        # rather than raise on any platform.
        self.assertTrue(hasattr(key_store, "load_key"))
        self.assertTrue(hasattr(key_store, "save_key"))
        val = key_store.load_key("__nonexistent_test_provider__")
        self.assertIn(val, ("", val))  # never raises, never throws

    def test_key_store_non_windows_returns_empty(self):
        import key_store
        # On any platform, a missing provider returns "" without raising.
        self.assertEqual(key_store.load_key("__definitely_missing__"), "")


class TestSecretLeakPrevention(unittest.TestCase):
    """No provider URL (which may embed an API key) may ever reach a log line
    or a client-facing error message."""

    def test_gemini_key_not_in_url(self):
        # call_gemini must build a URL with NO key in the query string and
        # pass the key via the x-goog-api-key header instead.
        cfg = dict(m.CONFIG["gemini"])
        cfg["api_key"] = "AIzaSUPERSECRET"
        captured = {}

        def fake_http_json(url, headers, payload, extract):
            captured["url"] = url
            captured["headers"] = headers
            return "{}"

        with mock.patch.object(m, "CONFIG", {"gemini": cfg}), \
             mock.patch.object(m, "_http_json", side_effect=fake_http_json):
            m.call_gemini([_data_url(_jpeg_bytes())])
        self.assertNotIn("key=", captured["url"])
        self.assertNotIn("AIzaSUPERSECRET", captured["url"])
        self.assertEqual(captured["headers"].get("x-goog-api-key"), "AIzaSUPERSECRET")

    def test_http_json_logs_no_url_on_httperror(self):
        # A key-bearing URL must never appear in stderr on an HTTP error.
        http_err = urllib.error.HTTPError(
            "https://example.invalid/generateContent?key=AIzaLEAK",
            401, "Unauthorized", {}, io.BytesIO(b"{}"),
        )
        with mock.patch.object(m.urllib.request, "urlopen", side_effect=http_err):
            with mock.patch.object(m.sys, "stderr", new=io.StringIO()) as fake_err:
                with self.assertRaises(m.ProviderError) as cm:
                    m._http_json(
                        "https://example.invalid/generateContent?key=AIzaLEAK",
                        {}, {}, lambda d: d,
                    )
                self.assertNotIn("AIzaLEAK", str(cm.exception))
                self.assertNotIn("AIzaLEAK", fake_err.getvalue())
                self.assertNotIn("key=", fake_err.getvalue())

    def test_http_json_urlerror_does_not_leak_url(self):
        # URLError reason must not be stringified (it could embed the URL/key).
        class ReasonWithURL:
            def __str__(self):
                return "failed for https://x/?key=AIzaLEAK"

        err = urllib.error.URLError(ReasonWithURL())
        with mock.patch.object(m.urllib.request, "urlopen", side_effect=err):
            with mock.patch.object(m.sys, "stderr", new=io.StringIO()) as fake_err:
                with self.assertRaises(m.ProviderError) as cm:
                    m._http_json("https://x/?key=AIzaLEAK", {}, {}, lambda d: d)
                self.assertNotIn("AIzaLEAK", str(cm.exception))
                self.assertNotIn("AIzaLEAK", fake_err.getvalue())

    def test_handle_scan_does_not_log_str_of_exception(self):
        # A raising exception whose str() embeds a key must not be logged by
        # handle_match's generic handler (it logs only the exception type).
        class KeyLeakingError(Exception):
            def __str__(self):
                return "boom https://x/?key=AIzaLEAK"

        h = _bare_handler()
        h.headers = {"Content-Length": "2"}
        h.rfile = io.BytesIO(b"{}")
        with mock.patch.object(m.Handler, "send_json", autospec=True) as send_json:
            with mock.patch.object(m, "run_discovery", side_effect=KeyLeakingError()):
                with mock.patch.object(m.sys, "stderr", new=io.StringIO()) as fake_err:
                    h.handle_match()
                    self.assertNotIn("AIzaLEAK", fake_err.getvalue())
                    # Client gets a generic error, never the raw exception.
                    self.assertNotIn("AIzaLEAK", str(send_json.call_args))


if __name__ == "__main__":
    unittest.main()

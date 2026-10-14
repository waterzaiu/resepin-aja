#!/usr/bin/env python3
"""
Resep in aja — Multi-Provider Local Server
==========================================

Satu server, dukung 6 provider AI Vision sekaligus:
  - OpenAI        (GPT-4o, GPT-4o-mini, GPT-4-vision-preview)
  - Anthropic     (Claude 3.5 Sonnet, Claude 3 Haiku, dst)
  - Google Gemini (gemini-1.5-flash, gemini-2.0-flash-exp, dst)
  - Groq          (llama-3.2-90b-vision-preview)
  - OpenRouter    (aggregator — akses ratusan model dengan 1 key)
  - BigModel      (GLM-4V, glm-4v-flash) — Z.ai / Zhipu AI
  - xAI           (Grok — grok-4 vision)
  - SiliconFlow   (DeepSeek-VL2, Qwen2-VL, InternVL)

Cara pakai:
  1. Set environment variable API key untuk provider yang kamu punya:
       export OPENAI_API_KEY="sk-..."
       export ANTHROPIC_API_KEY="sk-ant-..."
       export GEMINI_API_KEY="AIza..."
       export GROQ_API_KEY="gsk_..."
       export OPENROUTER_API_KEY="sk-or-..."
       export BIGMODEL_API_KEY="xxx.xxx"
       export XAI_API_KEY="xai-..."
       export SILICONFLOW_API_KEY="sk-..."

     Atau edit langsung di file ini pada bagian KONFIGURASI di bawah.

  2. Pilih provider utama (default: auto — pakai yang pertama punya key):
       export PROVIDER=openai    # atau: anthropic, gemini, xai, groq, openrouter, bigmodel, siliconflow, auto

  3. Jalankan:
       python3 server.py

  4. Buka http://localhost:8787 di browser.

  Auto-fallback (opt-in): kalau provider utama gagal (rate limit, key invalid,
  dst) dan fallback antar-provider diizinkan (default: nonaktif demi privasi),
  server otomatis coba provider lain yang punya key.

Dependency: Pillow (server-side image validation/sanitization; lihat
requirements.txt). Semua library lain dari Python 3.8+ standard library.
"""

import http.server
import json
import os
import sys
import base64
import io
import re
import time
import threading
import uuid
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

# Pillow is used server-side to validate and sanitize uploaded images (signature
# check, decode, EXIF strip, re-encode). Declared in requirements.txt.
try:
    from PIL import Image, UnidentifiedImageError
    _PIL_AVAILABLE = True
except Exception:  # pragma: no cover - documented graceful degradation
    Image = None
    UnidentifiedImageError = Exception
    _PIL_AVAILABLE = False

# Key diambil dari environment (jika diset) atau penyimpanan lokal terenkripsi.
from key_store import load_key
from recipe_sources import mixed_recipes

# Recipe discovery: deterministic matching + provider adapters (official APIs
# only). Imported lazily-safe: these are stdlib-only modules with no network
# at import time.
import recipe_discovery
import ingredients as _ingredients
import seed_data

def provider_key(provider, env_name):
    return os.environ.get(env_name) or load_key(provider)


# ---------------------------------------------------------------------------
# Security / resource configuration (conservative, configurable defaults).
# ---------------------------------------------------------------------------
def _int_env(name, default, minimum=1):
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def _bool_env(name, default):
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


PUBLIC_DEPLOYMENT = _bool_env("PUBLIC_DEPLOYMENT", "false")

SCAN_RATE_LIMIT_REQUESTS = _int_env("SCAN_RATE_LIMIT_REQUESTS", 5, minimum=1)
SCAN_RATE_LIMIT_WINDOW_SECONDS = _int_env("SCAN_RATE_LIMIT_WINDOW_SECONDS", 60, minimum=1)
MAX_CONCURRENT_SCANS = _int_env("MAX_CONCURRENT_SCANS", 2, minimum=1)
SCAN_DEADLINE_SECONDS = _int_env("SCAN_DEADLINE_SECONDS", 120, minimum=10)

# Upload policy (single source of truth, mirrored in the frontend).
MAX_FILES = 5
MAX_BYTES_PER_FILE = 4 * 1024 * 1024      # 4 MB
MAX_TOTAL_BYTES = 12 * 1024 * 1024        # 12 MB
MAX_IMAGE_WIDTH = 4096
MAX_IMAGE_HEIGHT = 4096
MAX_DECODED_PIXELS = 16 * 1000 * 1000     # 16,000,000 decoded pixels (bomb guard)

# Privacy: cross-provider fallback is OFF by default and is opt-in per request
# (the frontend sends an explicit `allowFallback` form field). When disabled, a
# photo is only ever sent to the single preferred/first provider. Operators may
# still force it on globally via env var, but the per-request opt-in is the
# privacy-first default.
ALLOW_CROSS_PROVIDER_FALLBACK = _bool_env("ALLOW_CROSS_PROVIDER_FALLBACK", "false")

# CORS / origin controls. Same-origin by default (no CORS headers emitted).
ALLOWED_ORIGINS = tuple(
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()
)
ALLOWED_HOSTS = tuple(
    h.strip().lower() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()
)

# Rate limiter state (per client IP). Bounded to avoid unbounded growth.
_rate_lock = threading.Lock()
_rate_state = {}
_RATE_STATE_MAX = 4096

# Global semaphore bounding concurrent AI processing (resource exhaustion guard).
_scan_semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_SCANS)



# =========================================================
# KONFIGURASI (boleh edit langsung atau pakai env var)
# =========================================================
CONFIG = {
    "openai": {
        "api_key": provider_key("openai", "OPENAI_API_KEY"),
        "base_url": "https://api.openai.com/v1/chat/completions",
        "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
    },
    "anthropic": {
        "api_key": provider_key("anthropic", "ANTHROPIC_API_KEY"),
        "base_url": "https://api.anthropic.com/v1/messages",
        "model": os.environ.get("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022"),
    },
    "gemini": {
        "api_key": provider_key("gemini", "GEMINI_API_KEY"),
        "base_url": "https://generativelanguage.googleapis.com/v1beta/models",
        "model": os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite"),
    },
    "xai": {
        "api_key": provider_key("xai", "XAI_API_KEY"),
        "base_url": "https://api.x.ai/v1/chat/completions",
        "model": os.environ.get("XAI_MODEL", "grok-4-1-fast-non-reasoning"),
    },
    "groq": {
        "api_key": provider_key("groq", "GROQ_API_KEY"),
        "base_url": "https://api.groq.com/openai/v1/chat/completions",
        "model": os.environ.get("GROQ_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct"),
    },
    "openrouter": {
        "api_key": provider_key("openrouter", "OPENROUTER_API_KEY"),
        "base_url": "https://openrouter.ai/api/v1/chat/completions",
        # OpenRouter pakai format "provider/model" contoh "google/gemini-2.0-flash-exp:free"
        "model": os.environ.get("OPENROUTER_MODEL", "google/gemini-2.0-flash-exp:free"),
    },
    "bigmodel": {
        "api_key": os.environ.get("BIGMODEL_API_KEY") or os.environ.get("ZAI_API_KEY") or load_key("bigmodel"),
        "base_url": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "model": os.environ.get("BIGMODEL_MODEL", "glm-4v-flash"),
    },
    "siliconflow": {
        "api_key": provider_key("siliconflow", "SILICONFLOW_API_KEY"),
        # SiliconFlow OpenAI-compatible endpoint.
        # Host banyak model vision: DeepSeek-VL2, Qwen2-VL, InternVL, glm-4v, dll.
        "base_url": "https://api.siliconflow.cn/v1/chat/completions",
        # Default: DeepSeek-VL2 (model vision DeepSeek)
        # Alternatif: "Qwen/Qwen2-VL-72B-Instruct", "OpenGVLab/InternVL2-Llama3-76B",
        #             "pro/visionglm-4b", "TeleAI/TeleMM-7B"
        "model": os.environ.get("SILICONFLOW_MODEL", "deepseek-ai/deepseek-vl2"),
    },
}

# Provider utama: "auto" = pakai yang pertama punya key
PREFERRED_PROVIDER = os.environ.get("PROVIDER", "auto").lower()

# Canonical provider order (single source of truth). Derive auto-selection,
# missing-key messages, health output, docs, and console listings from here.
# xAI is included so it participates in auto-selection exactly like the rest.
PROVIDER_ORDER = (
    "openai", "anthropic", "gemini", "xai", "groq", "openrouter",
    "bigmodel", "siliconflow",
)

PORT = int(os.environ.get("PORT", "8787"))
# =========================================================

SYSTEM_PROMPT = """Anda adalah "Resep in aja", asisten AI zero-waste dari Indonesia.
Tugas Anda: melihat foto bahan makanan dari kulkas pengguna, lalu menghasilkan SATU resep masakan Indonesia praktis dan 2-3 ide menu alternatif yang memanfaatkan bahan-bahan tersebut. Produk kemasan seperti Indomie boleh dikenali dari label yang terlihat; jangan mengarang isi yang tidak terlihat.

Aturan WAJIB:
1. Identifikasi SEMUA bahan makanan yang terlihat di gambar (termasuk yang layu, sisa, atau potongan).
2. Pilih SATU masakan Indonesia rumahan yang paling masuk akal dibuat dari bahan-bahan tersebut. Hindari masakan rumit. Contoh masakan yang baik: tumis kangkung, orek tempe, sayur asem, capcay, nasi goreng sisa, sayur lodeh, soto sederhana, balado, teri tempe, sup sayur.
3. Pisahkan bahan menjadi dua kelompok:
   - "terdeteksi": bahan yang benar-benar terlihat di gambar dan dipakai di resep.
   - "kurang": bahan dapur umum (pantry staples) yang TIDAK terlihat di gambar tapi biasanya dibutuhkan untuk masakan ini, contoh: minyak goreng, garam, gula, bawang putih, bawang merah, cabai, kecap manis, saus tiram, terasi, kemiri, lengkuas, daun salam, daun jeruk, air, kaldu bubuk. Hanya sebut yang benar-benar relevan untuk resep ini (maksimal 6 item).
4. Langkah memasak: 4-7 langkah singkat, jelas, urutan logis, bahasa sehari-hari Indonesia. Setiap langkah WAJIB menyebut bahan/spesifik kuantitas kasar (mis. "2 siung bawang putih, cincang") dan tindakan konkret (panaskan, tumis, rebus, aduk) serta perkiraan durasi ("±3 menit") bila relevan. Hindari langkah terlalu umum seperti "masak sampai matang" tanpa detail.
5. Estimasi waktu masak (menit) dan porsi.

Format output WAJIB JSON murni (TIDAK boleh ada teks di luar JSON, TIDAK boleh markdown code fence):
{
  "namaMasakan": "string",
  "deskripsi": "string 1-2 kalimat menjelaskan masakan ini",
  "waktuMasak": number (menit),
  "porsi": number,
  "bahanTerdeteksi": ["string", ...],
  "bahanKurang": ["string", ...],
  "langkah": ["string", ...],
  "menuAlternatif": ["English dish name searchable on TheMealDB, e.g. Fried Rice", ...]
}
Untuk menuAlternatif: 2-3 nama hidangan berbeda yang memakai bahan terlihat; jangan mengarang URL atau gambar. Jika hanya satu menu masuk akal, boleh array kosong."""

USER_PROMPT = "Tolong identifikasi SEMUA bahan makanan dari seluruh foto/tampilan yang diberikan (foto bisa berisi beberapa bahan; crop dapat mengulang bahan yang sama, jangan dihitung ganda). Buat satu resep Indonesia yang cocok dari gabungan bahan. Output HANYA JSON sesuai format yang ditentukan."


# =========================================================
# PROVIDER IMPLEMENTATIONS
# =========================================================

class ProviderError(RuntimeError):
    """Provider failure with a retryability flag.

    ``retryable`` distinguishes transient failures (timeout, 429, 5xx, malformed
    model output) from permanent request failures (bad image, invalid request)
    that must not be replayed against every provider.
    """

    def __init__(self, message, retryable=True, status=502):
        super().__init__(message)
        self.retryable = retryable
        self.status = status


# Canonical image data-URL regex. Accepts base64 (and, for completeness,
# percent-encoded variants are rejected) for the four supported types.
_DATA_URL_RE = re.compile(
    r"^data:(image/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$"
)


def validate_data_url(data_url):
    """Validate a single image data URL. Returns (mime, raw_bytes).

    Raises ProviderError (non-retryable) on malformed input — a bad image must
    not be sent to multiple providers.
    """
    if not isinstance(data_url, str):
        raise ProviderError("Format gambar tidak valid.", retryable=False, status=400)
    match = _DATA_URL_RE.match(data_url.strip())
    if not match:
        raise ProviderError("Format data URL gambar tidak valid.", retryable=False, status=400)
    mime = match.group(1)
    b64 = re.sub(r"\s+", "", match.group(2))
    try:
        raw = base64.b64decode(b64, validate=True)
    except (ValueError, base64.binascii.Error):
        raise ProviderError("Base64 gambar tidak valid.", retryable=False, status=400)
    if not raw:
        raise ProviderError("Gambar kosong.", retryable=False, status=400)
    return mime, raw


def sanitize_image(raw, mime):
    """Validate and sanitize one uploaded image using Pillow.

    Verifies the actual content signature (not the claimed MIME), decodes the
    image, enforces pixel/dimension limits (decompression-bomb guard), strips
    all metadata (EXIF/GPS), converts animated GIFs to a single frame, and
    re-encodes to JPEG. Returns (mime, jpeg_bytes) or raises ProviderError.

    This is a security control: browser-side MIME checks are usability only.
    """
    if Image is None:
        raise ProviderError(
            "Server tidak dapat memvalidasi gambar (Pillow belum terpasang).",
            retryable=False, status=503,
        )
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.load()  # force full decode to catch truncation / bombs
            if im.width < 1 or im.height < 1:
                raise ProviderError("Gambar kosong.", retryable=False, status=400)
            if im.width > MAX_IMAGE_WIDTH or im.height > MAX_IMAGE_HEIGHT:
                raise ProviderError(
                    f"Dimensi gambar terlalu besar (maks {MAX_IMAGE_WIDTH}x{MAX_IMAGE_HEIGHT}).",
                    retryable=False, status=413,
                )
            if im.width * im.height > MAX_DECODED_PIXELS:
                raise ProviderError("Resolusi gambar terlalu besar.", retryable=False, status=413)
            # Strip animation to a single frame and remove alpha by compositing
            # onto a white background for the JPEG re-encode.
            frame = im.convert("RGB")
            out = io.BytesIO()
            frame.save(out, format="JPEG", quality=85)
            return "image/jpeg", out.getvalue()
    except ProviderError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as e:
        raise ProviderError("Gambar rusak atau bukan gambar valid.", retryable=False, status=400)


def _bounded_str(value, max_len, label):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > max_len:
        return None
    return value


def _bounded_str_list(value, max_items, max_len, label):
    if not isinstance(value, list) or len(value) > max_items:
        return None
    out = []
    for item in value:
        s = _bounded_str(item, max_len, label)
        if s is None:
            return None
        out.append(s)
    return out


def _bounded_positive_int(value, maximum):
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 1 or value > maximum:
        return None
    return value


def validate_recipe(recipe):
    """Validate and normalize an AI recipe object (Priority 4 schema contract).

    Returns a normalized recipe dict, or None if invalid. Rejects null, arrays,
    scalars, unexpected nesting, and excessive values so malformed output from
    one provider triggers fallback instead of being sent to the browser.
    """
    if not isinstance(recipe, dict):
        return None

    nama = _bounded_str(recipe.get("namaMasakan"), 200, "namaMasakan")
    if nama is None:
        return None

    deskripsi = _bounded_str(recipe.get("deskripsi"), 1000, "deskripsi")
    if deskripsi is None:
        deskripsi = ""

    waktu = _bounded_positive_int(recipe.get("waktuMasak"), 24 * 60)
    porsi = _bounded_positive_int(recipe.get("porsi"), 1000)
    if waktu is None or porsi is None:
        return None

    bahan_terdeteksi = _bounded_str_list(recipe.get("bahanTerdeteksi"), 100, 100, "bahanTerdeteksi")
    bahan_kurang = _bounded_str_list(recipe.get("bahanKurang"), 50, 100, "bahanKurang")
    langkah = _bounded_str_list(recipe.get("langkah"), 50, 500, "langkah")
    if bahan_terdeteksi is None or bahan_kurang is None or langkah is None:
        return None

    # menuAlternatif: bounded list of strings OR normalized recipe-card objects.
    alt = recipe.get("menuAlternatif", [])
    if not isinstance(alt, list) or len(alt) > 20:
        return None
    menu_alternatif = []
    for item in alt:
        if isinstance(item, str):
            s = _bounded_str(item, 200, "menuAlternatif")
            if s is None:
                return None
            menu_alternatif.append(s)
        elif isinstance(item, dict):
            name = _bounded_str(item.get("nama"), 200, "nama")
            if name is None:
                return None
            menu_alternatif.append({
                "nama": name,
                "url": _bounded_str(item.get("url", ""), 500, "url") or "",
                "thumbnail": _bounded_str(item.get("thumbnail", ""), 500, "thumbnail") or "",
            })
        else:
            return None

    return {
        "namaMasakan": nama,
        "deskripsi": deskripsi,
        "waktuMasak": waktu,
        "porsi": porsi,
        "bahanTerdeteksi": bahan_terdeteksi,
        "bahanKurang": bahan_kurang,
        "langkah": langkah,
        "menuAlternatif": menu_alternatif,
    }

def _image_parts(data_urls, max_images=None):
    """Validate every data URL and return (mime, b64) pairs.

    Every provider receives a LIST of validated data URLs (the canonical
    contract). ``max_images`` lets single-image providers deliberately select
    the original full image (the first one) while still validating the rest.
    """
    images = data_urls if isinstance(data_urls, list) else [data_urls]
    if not images:
        raise ProviderError("Tidak ada gambar untuk diproses.", retryable=False, status=400)
    if len(images) > MAX_FILES:
        raise ProviderError(f"Maksimal {MAX_FILES} gambar per scan.", retryable=False, status=400)
    parts = []
    for url in images:
        mime, _raw = validate_data_url(url)
        _, b64 = url.split(",", 1)
        parts.append((mime, b64))
    if max_images is not None:
        parts = parts[:max_images]
    return parts


def call_openai(data_urls):
    cfg = CONFIG["openai"]
    image_objs = [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
        for mime, b64 in _image_parts(data_urls)
    ]
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [{"type": "text", "text": USER_PROMPT}, *image_objs]},
        ],
        "max_tokens": 1500,
    }
    return _http_json(
        cfg["base_url"],
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
        payload=payload,
        extract=lambda d: d["choices"][0]["message"]["content"],
    )


def call_anthropic(data_urls):
    cfg = CONFIG["anthropic"]
    # Claude accepts multiple images in one message; one source object per image.
    image_objs = [
        {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}}
        for mime, b64 in _image_parts(data_urls)
    ]
    payload = {
        "model": cfg["model"],
        "max_tokens": 1500,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": [*image_objs, {"type": "text", "text": USER_PROMPT}]}],
    }
    return _http_json(
        cfg["base_url"],
        headers={"x-api-key": cfg["api_key"], "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
        payload=payload,
        extract=lambda d: d["content"][0]["text"],
    )


def call_gemini(data_urls):
    cfg = CONFIG["gemini"]
    images = data_urls if isinstance(data_urls, list) else [data_urls]
    # The API key is sent via the x-goog-api-key header, never embedded in the
    # request URL. Keys in query strings leak into proxy/access logs and into
    # exception messages that may be logged server-side.
    url = f"{cfg['base_url']}/{cfg['model']}:generateContent"
    image_parts = [
        {"inlineData": {"mimeType": mime, "data": b64}}
        for mime, b64 in _image_parts(images)
    ]
    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": USER_PROMPT}, *image_parts]}],
        "generationConfig": {"maxOutputTokens": 1500},
    }
    return _http_json(
        url,
        headers={"Content-Type": "application/json", "x-goog-api-key": cfg["api_key"]},
        payload=payload,
        extract=lambda d: d["candidates"][0]["content"]["parts"][0]["text"],
    )


def call_xai(data_urls):
    """xAI Grok chat completions with a vision-capable model (multi-image)."""
    cfg = CONFIG["xai"]
    image_objs = [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}", "detail": "high"}}
        for mime, b64 in _image_parts(data_urls)
    ]
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [{"type": "text", "text": USER_PROMPT}, *image_objs]},
        ],
        "max_tokens": 1500,
    }
    return _http_json(
        cfg["base_url"],
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
        payload=payload,
        extract=lambda d: d["choices"][0]["message"]["content"],
    )


def call_groq(data_urls):
    cfg = CONFIG["groq"]
    image_objs = [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
        for mime, b64 in _image_parts(data_urls)
    ]
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [{"type": "text", "text": USER_PROMPT}, *image_objs]},
        ],
        "max_tokens": 1500,
    }
    return _http_json(
        cfg["base_url"],
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
        payload=payload,
        extract=lambda d: d["choices"][0]["message"]["content"],
    )


def call_openrouter(data_urls):
    cfg = CONFIG["openrouter"]
    image_objs = [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
        for mime, b64 in _image_parts(data_urls)
    ]
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [{"type": "text", "text": USER_PROMPT}, *image_objs]},
        ],
        "max_tokens": 1500,
    }
    return _http_json(
        cfg["base_url"],
        headers={
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:8787",
            "X-Title": "Resep in aja",
        },
        payload=payload,
        extract=lambda d: d["choices"][0]["message"]["content"],
    )


def call_bigmodel(data_urls):
    cfg = CONFIG["bigmodel"]
    image_objs = [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
        for mime, b64 in _image_parts(data_urls)
    ]
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [{"type": "text", "text": USER_PROMPT}, *image_objs]},
        ],
    }
    return _http_json(
        cfg["base_url"],
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
        payload=payload,
        extract=lambda d: d["choices"][0]["message"]["content"],
    )


def call_siliconflow(data_urls):
    """SiliconFlow — akses DeepSeek-VL2, Qwen2-VL, InternVL, dst. OpenAI-compatible."""
    cfg = CONFIG["siliconflow"]
    image_objs = [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
        for mime, b64 in _image_parts(data_urls)
    ]
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [{"type": "text", "text": USER_PROMPT}, *image_objs]},
        ],
        "max_tokens": 1500,
        "stream": False,
    }
    return _http_json(
        cfg["base_url"],
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
        payload=payload,
        extract=lambda d: d["choices"][0]["message"]["content"],
    )


PROVIDERS = {
    "openai": {"call": call_openai, "label": "OpenAI GPT-4o"},
    "anthropic": {"call": call_anthropic, "label": "Anthropic Claude"},
    "gemini": {"call": call_gemini, "label": "Google Gemini"},
    "xai": {"call": call_xai, "label": "xAI Grok"},
    "groq": {"call": call_groq, "label": "Groq Llama 3.2"},
    "openrouter": {"call": call_openrouter, "label": "OpenRouter"},
    "bigmodel": {"call": call_bigmodel, "label": "BigModel GLM-4V"},
    "siliconflow": {"call": call_siliconflow, "label": "SiliconFlow (DeepSeek-VL2)"},
}


def _http_json(url, headers, payload, extract):
    """Helper: POST JSON, return extracted text. Raise ProviderError on error.

    Never surfaces raw provider responses (which may embed credentials) to the
    caller; detailed errors are logged server-side only.
    """
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return extract(data)
    except urllib.error.HTTPError as e:
        # 429 / 5xx are retryable; 400/401/403 are permanent (bad request/key).
        retryable = e.code in (429, 500, 502, 503, 504)
        # Never log the URL (it may embed an API key) or the raw response body
        # (it may echo credentials). Log only the status code.
        sys.stderr.write(f"[provider] HTTP {e.code} dari endpoint\n")
        if retryable:
            raise ProviderError(
                "Provider AI sedang sibuk/error. Coba lagi sebentar.",
                retryable=True, status=502,
            )
        raise ProviderError(
            "Provider menolak permintaan (periksa key/kuota).",
            retryable=False, status=502,
        )
    except TimeoutError:
        raise ProviderError("Provider AI tidak merespons dalam 25 detik.", retryable=True, status=504)
    except urllib.error.URLError as e:
        # e.reason may be a nested exception whose string contains the request
        # URL (and thus any key embedded in it). Log only the reason's type,
        # never its text.
        reason_type = type(e.reason).__name__
        sys.stderr.write(f"[provider] Network error ({reason_type})\n")
        raise ProviderError(f"Network error: {reason_type}", retryable=True, status=502)
    except (KeyError, IndexError, TypeError) as e:
        raise ProviderError("Response provider tidak sesuai format.", retryable=True, status=502)


def get_active_providers():
    """Return list of providers yang punya API key (canonical order)."""
    return [name for name in PROVIDER_ORDER if CONFIG[name]["api_key"]]


def choose_provider_chain():
    """Return list of provider names sesuai urutan prioritas (canonical order)."""
    active = get_active_providers()
    if not active:
        return []

    if PREFERRED_PROVIDER == "auto":
        return [p for p in PROVIDER_ORDER if p in active]
    else:
        if PREFERRED_PROVIDER in active:
            others = [p for p in PROVIDER_ORDER if p in active and p != PREFERRED_PROVIDER]
            return [PREFERRED_PROVIDER] + others
        return active


def call_vision_with_fallback(data_urls, allow_fallback=None):
    """Coba provider sesuai urutan, fallback kalau gagal.

    Each attempt now includes transport, response extraction, JSON parsing, and
    recipe schema validation (Priority 4). Malformed/invalid output from one
    provider is treated as a retryable provider failure. Permanent failures
    (bad image, invalid request, auth) are NOT replayed against every provider.

    ``allow_fallback`` is the per-request opt-in. When None it falls back to the
    global ``ALLOW_CROSS_PROVIDER_FALLBACK`` setting; when explicitly False the
    photo is sent only to the first (preferred) provider.

    Returns (provider_name, validated_recipe_dict).
    """
    chain = choose_provider_chain()
    if not chain:
        raise ProviderError(
            "Tidak ada API key yang dikonfigurasi. Set minimal salah satu: "
            + ", ".join(p.upper() + "_API_KEY" for p in PROVIDER_ORDER) + ".",
            retryable=False, status=503,
        )

    # Privacy: without cross-provider fallback, only the first provider is used.
    fallback_allowed = (
        ALLOW_CROSS_PROVIDER_FALLBACK if allow_fallback is None else bool(allow_fallback)
    )
    if not fallback_allowed:
        chain = chain[:1]

    deadline = time.monotonic() + SCAN_DEADLINE_SECONDS
    errors = []
    for provider_name in chain:
        if time.monotonic() >= deadline:
            errors.append("deadline: total waktu scan habis")
            break
        try:
            sys.stderr.write(f"  → Mencoba provider: {provider_name} ({CONFIG[provider_name]['model']})\n")
            raw_content = PROVIDERS[provider_name]["call"](data_urls)

            # Parse + validate the recipe INSIDE the fallback loop so malformed
            # output from one provider can be retried on the next.
            try:
                parsed = parse_recipe(raw_content)
            except RuntimeError as e:
                raise ProviderError(str(e), retryable=True, status=502)
            recipe = validate_recipe(parsed)
            if recipe is None:
                raise ProviderError("Respon AI tidak lolos validasi skema.", retryable=True, status=502)
            return provider_name, recipe
        except ProviderError as e:
            err_msg = str(e)
            sys.stderr.write(f"    ✗ {provider_name} gagal: {err_msg[:150]}\n")
            if not e.retryable:
                # Permanent failure (bad image / bad request): do not replay.
                raise
            errors.append(f"{provider_name}: {err_msg}")
            continue
        except Exception as e:
            sys.stderr.write(f"    ✗ {provider_name} gagal tak terduga: {type(e).__name__}\n")
            errors.append(f"{provider_name}: internal error")
            continue

    raise ProviderError(
        f"Semua provider gagal. Errors: {' | '.join(errors[:3])}",
        retryable=True, status=502,
    )


# =========================================================
# HTTP SERVER
# =========================================================
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Server header hidden to avoid leaking implementation details.
    server_version = "ResepInAja"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ------------------------------------------------------------------
    # Request guard helpers
    # ------------------------------------------------------------------
    def client_ip(self):
        return self.client_address[0] if self.client_address else "unknown"

    def _rate_limited(self):
        """Return True if the client IP has exceeded the scan rate limit."""
        ip = self.client_ip()
        now = time.monotonic()
        with _rate_lock:
            if len(_rate_state) >= _RATE_STATE_MAX:
                _rate_state.clear()  # bounded growth
            hits = _rate_state.setdefault(ip, [])
            # Drop expired timestamps.
            cutoff = now - SCAN_RATE_LIMIT_WINDOW_SECONDS
            hits[:] = [t for t in hits if t > cutoff]
            if len(hits) >= SCAN_RATE_LIMIT_REQUESTS:
                return True
            hits.append(now)
            return False

    def _host_allowed(self):
        """Validate the Host header against ALLOWED_HOSTS when configured."""
        if not ALLOWED_HOSTS:
            return True
        host = (self.headers.get("Host") or "").split(":")[0].strip().lower()
        return host in ALLOWED_HOSTS

    def _origin_allowed(self):
        """Validate Origin/Referer when ALLOWED_ORIGINS is configured.

        Same-origin requests send no Origin on GET and a same-origin Origin on
        POST; when ALLOWED_ORIGINS is empty no restriction is applied (local
        mode). When set, cross-origin POSTs are rejected.
        """
        if not ALLOWED_ORIGINS:
            return True
        origin = self.headers.get("Origin") or self.headers.get("Referer") or ""
        if not origin:
            # Same-origin POSTs may omit Origin; allow only if not enforcing strict.
            return True
        for allowed in ALLOWED_ORIGINS:
            if origin == allowed or origin.startswith(allowed.rstrip("/") + "/"):
                return True
        return False

    def _csp_nonce(self):
        nonce = base64.urlsafe_b64encode(uuid.uuid4().bytes).decode("ascii").rstrip("=")
        return nonce

    def _send_security_headers(self, content_type, cache_policy="no-store"):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "camera=(self), geolocation=(), microphone=(), usb=()")
        self.send_header("Cache-Control", cache_policy)
        # CORS: same-origin app, so no wildcard. Emit explicit allowed origin only
        # when configured (never "*").
        if ALLOWED_ORIGINS:
            origin = self.headers.get("Origin") or ""
            if origin in ALLOWED_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

    def do_GET(self):
        if not self._host_allowed():
            self.send_json({"error": "Host tidak diizinkan."}, status=400)
            return
        if self.path == "/" or self.path == "/index.html":
            self.serve_html()
        elif self.path.startswith("/api/resep?q="):
            from urllib.parse import parse_qs, urlsplit
            query = parse_qs(urlsplit(self.path).query).get("q", [""])[0].strip()
            if not query or len(query) > 80:
                self.send_json({"error": "Kata kunci harus 1–80 karakter."}, status=400)
            else:
                self.send_json({"recipes": mixed_recipes(query, search_cookpad, limit=20)})
        elif self.path == "/api/viral":
            self.send_json({"recipes": [dict(card, recommended=i == 0) for i, card in enumerate(COOKPAD_RENDANG)]})
        elif self.path == "/api/inspirasi":
            recipes = mixed_recipes("masakan rumahan ayam telur", search_cookpad, limit=18)
            self.send_json({"recipes": recipes or lookup_recipe_cards(
                ["Fried Rice", "Chicken Curry", "Ramen", "Noodles", "Omelette", "Soup"]
            )})
        elif self.path == "/health":
            self.handle_health()
        elif self.path == "/ready":
            self.handle_health()
        elif self.path.startswith("/api/recipes/search"):
            from urllib.parse import parse_qs, urlsplit
            qs = parse_qs(urlsplit(self.path).query)
            query = qs.get("q", [""])[0].strip()
            self.send_json({"recipes": search_discovery(query)})
        elif self.path.startswith("/api/recipes/"):
            recipe_id = self.path[len("/api/recipes/"):].split("?", 1)[0]
            self.send_json(get_recipe_by_id(recipe_id))
        else:
            self.send_error(404, "Not found")

    def do_POST(self):
        if not self._host_allowed():
            self.send_json({"error": "Host tidak diizinkan."}, status=400)
            return
        if not self._origin_allowed():
            self.send_json({"error": "Origin tidak diizinkan."}, status=403)
            return
        if self.path == "/api/scan-resep":
            self.handle_scan()
        elif self.path == "/api/recipes/match":
            self.handle_match()
        elif self.path == "/api/ingredients/normalize":
            self.handle_normalize()
        else:
            self.send_error(404, "Not found")

    def handle_health(self):
        """Liveness + readiness. 503 when no provider can perform scans."""
        active = get_active_providers()
        chain = choose_provider_chain()
        ok = bool(active)
        self.send_json({
            "ok": ok,
            "ready": ok,
            "active_providers": active,
            "preferred": PREFERRED_PROVIDER,
            "chain": chain,
            "models": {p: CONFIG[p]["model"] for p in active},
            "supabase_configured": bool(recipe_discovery.SupabaseRecipeProvider().client.is_configured()),
            "external_recipes_enabled": recipe_discovery.ENABLE_EXTERNAL,
            "pillow_available": _PIL_AVAILABLE,
            "cross_provider_fallback": ALLOW_CROSS_PROVIDER_FALLBACK,
        }, status=200 if ok else 503)

    def serve_html(self):
        html_path = Path(__file__).parent / "resep-in-aja.html"
        if not html_path.exists():
            self.send_error(404, "HTML file not found")
            return
        with open(html_path, "r", encoding="utf-8") as f:
            content = f.read()
        body = content.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_security_headers("text/html")
        # CSP: inline CSS/JS is present, so we cannot use a strict nonce without
        # refactoring the HTML. Use a same-origin default-src that disallows
        # remote script/frame and object, without unsafe-eval.
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; "
            "connect-src 'self'; frame-ancestors 'none'; object-src 'none'; "
            "base-uri 'self'; form-action 'self'",
        )
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_security_headers("application/json")
        self.end_headers()
        self.wfile.write(body)

    def handle_match(self):
        """POST /api/recipes/match — deterministic matching against detected
        ingredients (photo scan OR manual entry). Runs Supabase -> TheMealDB ->
        AI fallback order. No secrets in response."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > 1_000_000:
                self.send_json({"error": "Request body kosong atau terlalu besar."}, status=413)
                return
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self.send_json({"error": "Body harus JSON valid."}, status=400)
                return
            ingredients = body.get("ingredients")
            preferences = body.get("preferences") or {}
            if not isinstance(ingredients, list) or not ingredients:
                self.send_json({"error": "Field 'ingredients' (array) wajib diisi."}, status=400)
                return
            if not all(isinstance(i, str) for i in ingredients):
                self.send_json({"error": "Setiap ingredient harus string."}, status=400)
                return
            if len(ingredients) > 50:
                self.send_json({"error": "Maksimal 50 bahan."}, status=400)
                return

            result = run_discovery(ingredients, preferences)
            self.send_json(result)
        except Exception as e:
            # Log only the exception type, never str(e): a raw exception may
            # embed a provider URL (and thus an API key) in its message.
            sys.stderr.write(f"handle_match error: {type(e).__name__}\n")
            self.send_json({"error": "Terjadi kesalahan di server."}, status=500)

    def handle_normalize(self):
        """POST /api/ingredients/normalize — normalize ingredient names."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > 100_000:
                self.send_json({"error": "Body kosong atau terlalu besar."}, status=413)
                return
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self.send_json({"error": "Body harus JSON valid."}, status=400)
                return
            ingredients = body.get("ingredients")
            if not isinstance(ingredients, list):
                self.send_json({"error": "Field 'ingredients' (array) wajib diisi."}, status=400)
                return
            normalized = _ingredients.normalize_ingredients(ingredients)
            mapping = []
            for raw_item, canon in zip(ingredients, normalized):
                mapping.append({"input": raw_item, "canonical": canon})
            self.send_json({"normalized": normalized, "mapping": mapping})
        except Exception as e:
            # Log only the exception type; never str(e) (may embed a key/URL).
            sys.stderr.write(f"handle_normalize error: {type(e).__name__}\n")
            self.send_json({"error": "Terjadi kesalahan di server."}, status=500)

    def handle_scan(self):
        try:
            # Rate limit (per client IP).
            if self._rate_limited():
                self.send_json({
                    "error": "Terlalu banyak permintaan. Coba lagi nanti.",
                    "retryAfterSeconds": SCAN_RATE_LIMIT_WINDOW_SECONDS,
                }, status=429)
                return

            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self.send_json({"error": "Expected multipart/form-data"}, status=400)
                return

            # Bound the request body before reading it. Reject malformed
            # Content-Length (non-integer / negative) cleanly with 400.
            raw_length = self.headers.get("Content-Length", "")
            try:
                length = int(raw_length)
            except (TypeError, ValueError):
                self.send_json({"error": "Content-Length tidak valid."}, status=400)
                return
            if length <= 0 or length > MAX_TOTAL_BYTES + (MAX_FILES * 4096):
                self.send_json({
                    "error": f"Request kosong atau terlalu besar (maks {MAX_TOTAL_BYTES // (1024 * 1024)} MB foto)."
                }, status=413)
                return
            raw = self.rfile.read(length)
            images, allow_fallback = self.parse_multipart_images(raw, content_type)

            if not images:
                self.send_json({"error": "Gambar tidak ditemukan dalam request."}, status=400)
                return

            if len(images) > MAX_FILES or sum(len(data) for data, _ in images) > MAX_TOTAL_BYTES:
                self.send_json({
                    "error": f"Maksimal {MAX_FILES} foto, total {MAX_TOTAL_BYTES // (1024 * 1024)} MB."
                }, status=400)
                return
            if any(len(data) > MAX_BYTES_PER_FILE for data, _ in images):
                self.send_json({
                    "error": f"Maksimal {MAX_BYTES_PER_FILE // (1024 * 1024)} MB per foto."
                }, status=400)
                return

            # Validate + sanitize every image with Pillow (Priority 5).
            # Re-encodes to JPEG, strips metadata, enforces dimensions/pixels.
            data_urls = []
            for data, mime in images:
                try:
                    _mime, jpeg = sanitize_image(data, mime)
                except ProviderError as e:
                    self.send_json({"error": str(e)}, status=e.status)
                    return
                data_urls.append(f"data:image/jpeg;base64,{base64.b64encode(jpeg).decode('ascii')}")

            # Bounded concurrency (Priority: resource exhaustion guard).
            acquired = _scan_semaphore.acquire(timeout=5)
            if not acquired:
                self.send_json({"error": "Server sedang sibuk. Coba lagi sebentar."}, status=503)
                return
            try:
                # Canonical contract: always pass a LIST of data URLs.
                provider_used, recipe = call_vision_with_fallback(data_urls, allow_fallback=allow_fallback)
            except ProviderError as e:
                if e.status == 503 and "API key" in str(e):
                    self.send_json({
                        "error": "Belum ada API key yang dikonfigurasi di server.py. "
                                 "Set minimal salah satu: "
                                 + ", ".join(p.upper() + "_API_KEY" for p in PROVIDER_ORDER)
                                 + ". Lihat README.md untuk cara dapat API key gratis."
                    }, status=503)
                else:
                    self.send_json({"error": str(e)}, status=e.status)
                return
            finally:
                _scan_semaphore.release()

            # recipe is already schema-validated; enrich with alternatives.
            detected = recipe.get("bahanTerdeteksi", [])
            query = ingredient_query(detected)
            cards = mixed_recipes(query, search_cookpad, limit=18) if query else []
            alt = rank_cards(cards, detected)
            if not alt:
                alt = recommended_cards(detected) or lookup_recipe_cards(recipe.get("menuAlternatif", []), detected)
            recipe["menuAlternatif"] = alt
            self.send_json({
                "recipe": recipe,
                "provider": provider_used,
                "model": CONFIG[provider_used]["model"],
            })

        except Exception as e:
            # Log only the exception type, never str(e): a raw exception may
            # embed a provider URL (and thus an API key) in its message.
            sys.stderr.write(f"Server error: {type(e).__name__}\n")
            self.send_json({"error": "Terjadi kesalahan di server."}, status=500)

    def parse_multipart_images(self, raw, content_type):
        from email.parser import BytesParser
        from email.policy import default

        message = BytesParser(policy=default).parsebytes(
            b"MIME-Version: 1.0\r\nContent-Type: " + content_type.encode("ascii", "ignore") +
            b"\r\n\r\n" + raw
        )
        images = []
        allow_fallback = None
        for part in message.iter_parts():
            mime = part.get_content_type().lower()
            if part.get_param("name", header="content-disposition") == "image" and mime in (
                "image/jpeg", "image/png", "image/webp", "image/gif"
            ):
                images.append((part.get_payload(decode=True), mime))
            elif part.get_param("name", header="content-disposition") == "allowFallback":
                # Per-request opt-in to cross-provider fallback (privacy). A
                # truthy value opts in; anything else (including absence) leaves
                # the global default in effect.
                val = (part.get_payload(decode=True) or b"").decode("utf-8", "ignore").strip().lower()
                allow_fallback = val in ("true", "1", "yes", "on")
        return images, allow_fallback

    def parse_multipart(self, raw, content_type):
        parts = content_type.split("boundary=")
        if len(parts) < 2:
            return None, None
        boundary = parts[1].strip().strip('"')
        boundary_bytes = ("--" + boundary).encode()

        segments = raw.split(boundary_bytes)
        for seg in segments:
            if not seg or seg.strip() in (b"", b"--", b"--\r\n", b"\r\n"):
                continue
            if seg.startswith(b"\r\n"):
                seg = seg[2:]
            if seg.endswith(b"\r\n"):
                seg = seg[:-2]
            sep_idx = seg.find(b"\r\n\r\n")
            if sep_idx < 0:
                continue
            header_block = seg[:sep_idx].decode("utf-8", errors="replace")
            body = seg[sep_idx + 4:]

            if 'name="image"' in header_block or 'name=image' in header_block:
                ct = "image/jpeg"
                for line in header_block.split("\r\n"):
                    if line.lower().startswith("content-type:"):
                        ct = line.split(":", 1)[1].strip()
                        break
                return body, ct
        return None, None


COOKPAD_RENDANG = [
    {"nama": "Indomie rendang nyemek", "thumbnail": "https://img-global.cpcdn.com/recipes/c38158c51ba3a293/120x160cq50/indomie-rendang-nyemek-foto-resep-utama.jpg", "url": "https://cookpad.com/id/resep/16925069", "source": "Cookpad"},
    {"nama": "Indomie Rendang Kuah", "thumbnail": "https://img-global.cpcdn.com/recipes/12381a7b9b2d5e8c/120x160cq50/indomie-rendang-kuah-foto-resep-utama.jpg", "url": "https://cookpad.com/id/resep/16653660", "source": "Cookpad"},
    {"nama": "Seblak indomie rendang", "thumbnail": "https://img-global.cpcdn.com/recipes/a65b4f62dca96930/120x160f0.5_0.55525_1.0q50/seblak-indomie-rendang-foto-resep-utama.jpg", "url": "https://cookpad.com/id/resep/16263466", "source": "Cookpad"},
    {"nama": "Martabak Indomie Rendang", "thumbnail": "https://img-global.cpcdn.com/recipes/8022c138d6bbc5a8/120x160cq50/martabak-indomie-rendang-foto-resep-utama.jpg", "url": "https://cookpad.com/id/resep/14619964", "source": "Cookpad"},
    {"nama": "Indomie rendang toge", "thumbnail": "https://img-global.cpcdn.com/recipes/3756047309ef53bc/120x160cq50/indomie-rendang-toge-foto-resep-utama.jpg", "url": "https://cookpad.com/id/resep/16436932", "source": "Cookpad"},
    {"nama": "Nasi Goreng Rendang Ekspress", "thumbnail": "https://img-global.cpcdn.com/recipes/c1ceb8350572da04/120x160cq50/nasi-goreng-rendang-ekspress-foto-resep-utama.jpg", "url": "https://cookpad.com/id/resep/16485402", "source": "Cookpad"},
]


def search_cookpad(query, limit=12):
    """Search public Cookpad pages for actual recipe links and thumbnail URLs."""
    import re

    class EnoughRecipes(Exception):
        pass
    import urllib.parse
    from html.parser import HTMLParser

    class RecipeParser(HTMLParser):
        def __init__(self):
            super().__init__()
            self.in_card = False
            self.depth = 0
            self.card = None
            self.in_title = False
            self.cards = []

        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            if tag == "li" and "ranked-list__item" in attrs.get("class", "").split():
                self.in_card, self.depth, self.card = True, 1, {}
            elif self.in_card:
                if tag == "li":
                    self.depth += 1
                if tag == "a" and re.fullmatch(r"/id/resep/\d+", attrs.get("href", "")) and not self.card.get("url"):
                    self.card["url"] = "https://cookpad.com" + attrs["href"]
                    self.in_title = True
                if tag == "img" and "/recipes/" in attrs.get("src", "") and not self.card.get("thumbnail"):
                    self.card["thumbnail"] = attrs["src"]

        def handle_data(self, data):
            if self.in_title:
                self.card["nama"] = self.card.get("nama", "") + data

        def handle_endtag(self, tag):
            if tag == "a":
                self.in_title = False
            if self.in_card and tag == "li":
                self.depth -= 1
                if self.depth == 0:
                    if all(self.card.get(k) for k in ("nama", "thumbnail", "url")):
                        self.cards.append({"nama": self.card["nama"].strip(),
                                           "thumbnail": self.card["thumbnail"],
                                           "url": self.card["url"], "source": "Cookpad"})
                    self.in_card = False
                    if len(self.cards) >= limit:
                        raise EnoughRecipes

    if not query.strip():
        return []
    url = "https://cookpad.com/id/cari/" + urllib.parse.quote(query[:80])
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; ResepInAja/1.0)"})
    try:
        with urllib.request.urlopen(req, timeout=6) as response:
            page = response.read(1_500_000).decode("utf-8", "replace")
        parser = RecipeParser()
        try:
            parser.feed(page)
        except EnoughRecipes:
            pass
        return parser.cards[:limit]
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"Cookpad lookup gagal: {exc}\n")
        return []


# Alias normalisasi bahan: kata Indonesia -> kata kunci pencarian (Inggris untuk
# sumber internasional, Indonesia tetap dipertahankan untuk Cookpad/detik).
INGREDIENT_ALIASES = {
    "telur": "egg", "ayam": "chicken", "kentang": "potato", "nasi": "rice",
    "mie": "noodles", "mi": "noodles", "indomie": "noodles", "ikan": "fish",
    "udang": "shrimp", "daging": "beef", "tomat": "tomato", "jamur": "mushroom",
    "wortel": "carrot", "bayam": "spinach", "tahu": "tofu", "tempe": "tempeh",
    "kacang": "beans", "pisang": "banana", "keju": "cheese", "roti": "bread",
    "sapi": "beef", "bawang": "onion", "cabai": "chili", "cabe": "chili",
    "santan": "coconut", "kelapa": "coconut", "jagung": "corn", "ubi": "potato",
    "singkong": "cassava", "terong": "eggplant", "brokoli": "broccoli",
    "kol": "cabbage", "kubis": "cabbage", "sawi": "mustard", "kangkung": "spinach",
    "buncis": "beans", "lada": "pepper", "merica": "pepper", "gula": "sugar",
    "garam": "salt", "minyak": "oil", "kecap": "soy", "tepung": "flour",
    "susu": "milk", "mentega": "butter", "kuning": "egg", "putih": "egg",
}

# Kata non-bahan yang sering muncul di deskripsi AI dan harus diabaikan.
_NON_INGREDIENT = {
    "rasa", "goreng", "segar", "bungkus", "buah", "potong", "merk", "kemasan",
    "bahan", "dapur", "sisa", "seperempat", "setengah", "iris", "cincang",
}


def normalize_ingredient(item):
    """Normalize satu bahan jadi kata kunci kanonik (bahasa Inggris bila dikenal)."""
    import re
    text = str(item).lower()
    text = re.sub(r"[^a-z\s]", " ", text)
    keywords = []
    for word in text.split():
        if word in _NON_INGREDIENT:
            continue
        if len(word) <= 2 and word not in ("mi", "ubi"):
            continue
        keywords.append(INGREDIENT_ALIASES.get(word, word))
    return keywords


def ingredient_query(ingredients):
    """Bangun query pencarian dari bahan terdeteksi, dinormalisasi via alias.

    Tidak lagi berhenti setelah 4 kata — semua bahan dipertimbangkan supaya
    pencarian resep benar-benar relevan, bukan sekadar kata awal acak.
    """
    words = []
    for item in ingredients if isinstance(ingredients, list) else []:
        for word in normalize_ingredient(item):
            if word not in words:
                words.append(word)
    return " ".join(words[:6])


def _title_matches(title, keywords):
    """Hitung keyword bahan yang muncul di judul resep (bukti relevansi)."""
    text = str(title).lower()
    return [k for k in keywords if k and k in text]


def score_card(card, keywords):
    """Skor relevansi sebuah kartu resep terhadap keyword bahan.

    Mengembalikan tuple (score, matched_reason) — reason berupa string bukti
    kecocokan judul, bukan klaim ketersediaan bahan lengkap.
    """
    if not keywords:
        return 0, None
    title = str(card.get("nama", "")).lower()
    matched = _title_matches(title, keywords)
    if not matched:
        return 0, None
    # Skor berdasarkan jumlah keyword unik yang cocok di judul.
    return len(matched), ", ".join(dict.fromkeys(matched))


def rank_cards(cards, ingredients):
    """Filter & urutkan kartu resep menurut kecocokan judul dengan bahan.

    Kartu yang tidak cocok judulnya dengan bahan TIDAK dikembalikan (bukan
    hasil acak). Setiap kartu diberi `reason` (bukti judul) dan `recommended`
    hanya untuk kartu relevansi tertinggi. Keyword memuat kata asli (Indonesia)
    sekaligus alias Inggris supaya judul lokal tetap cocok.
    """
    keywords = []
    for item in ingredients if isinstance(ingredients, list) else []:
        raw = str(item).lower()
        for word in raw.split():
            if word in _NON_INGREDIENT:
                continue
            if len(word) <= 2 and word not in ("mi", "ubi"):
                continue
            keywords.append(word)  # kata asli
            alias = INGREDIENT_ALIASES.get(word)
            if alias:
                keywords.append(alias)
    keywords = list(dict.fromkeys(keywords))

    scored = []
    for card in cards or []:
        score, reason = score_card(card, keywords)
        if score > 0 and reason:
            scored.append((score, card, reason))
    scored.sort(key=lambda t: t[0], reverse=True)

    ranked = []
    for i, (score, card, reason) in enumerate(scored):
        ranked.append(dict(card, reason=reason, recommended=(i == 0)))
    return ranked


def recommended_cards(ingredients):
    text = " ".join(str(x).lower() for x in ingredients if isinstance(x, str))
    if "rendang" in text and any(x in text for x in ("indomie", "mie", "mi ")):
        # Relevansi: variasi dari bahan utama; bahan tambahan dicek di halaman resep.
        return [dict(card, recommended=i == 0) for i, card in enumerate(COOKPAD_RENDANG)]
    return []


def lookup_recipe_cards(names, ingredients=()):
    """Cari halaman resep sungguhan beserta thumbnail lewat indeks resep TheMealDB.

    Hasil difilter agar hanya menampilkan resep yang judulnya cocok dengan bahan
    terdeteksi — tidak pernah menampilkan menu acak yang tak berhubungan.
    """
    import urllib.parse

    names = names if isinstance(names, list) else []
    ingredients = ingredients if isinstance(ingredients, list) else []
    text = " ".join(str(item).lower() for item in ingredients)
    ingredient = "noodles" if any(word in text for word in ("mie", "mi ", "indomie")) else None
    if not ingredient:
        for word, english in (("telur", "egg"), ("ayam", "chicken"),
                              ("tempe", "tempeh"), ("nasi", "rice"),
                              ("kentang", "potato"), ("tomat", "tomato")):
            if word in text:
                ingredient = english
                break

    def search(url):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                return json.load(response).get("meals") or []
        except (OSError, ValueError) as exc:
            sys.stderr.write(f"Pencarian resep gagal: {exc}\n")
            return []

    urls = [f"https://www.themealdb.com/api/json/v1/1/search.php?s={urllib.parse.quote(name.strip()[:80])}"
            for name in names[:6] if isinstance(name, str) and name.strip()]
    if ingredient:
        urls.append(f"https://www.themealdb.com/api/json/v1/1/filter.php?i={ingredient}")
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(search, urls))

    cards = []
    seen = set()
    for meals in results:
        for meal in meals[:1]:
            if meal["idMeal"] in seen:
                continue
            seen.add(meal["idMeal"])
            cards.append({
                "nama": meal["strMeal"],
                "thumbnail": meal["strMealThumb"],
                "url": f"https://www.themealdb.com/meal/{meal['idMeal']}",
            })
            if len(cards) == 6:
                break

    # Filter relevansi: hanya kartu yang judulnya cocok dengan keyword bahan.
    ranked = rank_cards(cards, ingredients)
    if ranked:
        return ranked
    # Jika tidak ada yang cocok judulnya, jangan kembalikan hasil acak.
    return []


def _normalize_preferences(preferences):
    """Map the frontend preference shape to match_recipes' expected shape."""
    prefs = dict(preferences or {})
    out = {}
    if prefs.get("cuisine"):
        out["cuisines"] = [prefs["cuisine"]]
    if prefs.get("cuisines"):
        out["cuisines"] = list(prefs["cuisines"])
    if prefs.get("diet"):
        out["diet"] = [prefs["diet"]]
    if prefs.get("diets"):
        out["diet"] = list(prefs["diets"])
    if prefs.get("excludeAllergens"):
        out["excludeAllergens"] = list(prefs["excludeAllergens"])
    if prefs.get("maxTimeMinutes"):
        out["maxTimeMinutes"] = prefs["maxTimeMinutes"]
    if prefs.get("language"):
        out["language"] = prefs["language"]
    return out


def run_discovery(ingredients, preferences=None):
    """Run the deterministic discovery pipeline (Supabase -> TheMealDB -> seed)
    and, if it yields too few results, fall back to the AI scan path so the
    user still gets recommendations. Returns a JSON-ready dict with a stable
    frontend contract: {'recipes': [...], 'source': ..., 'fallback': bool}."""
    prefs = _normalize_preferences(preferences)

    # Seed/curated catalog is always available even without Supabase, so the
    # discovery backend never returns empty on a healthy install.
    seeded = seed_data.seed_recipe_catalog()

    discovery = recipe_discovery.discover_recipes(ingredients, prefs)
    matches = discovery["matches"]

    # Merge curated seed catalog if Supabase is not configured (so results are
    # still available offline / without credentials).
    seed_matches = []
    if not discovery["supabase_available"]:
        seed_matches = recipe_discovery.match_recipes(seeded, ingredients, prefs)
        seen_ids = {m.get("id") for m in matches}
        for m in seed_matches:
            if m.get("id") not in seen_ids:
                matches.append(m)

    matches = sorted(matches, key=lambda r: (r["matchScore"], int(r["verified"])), reverse=True)

    # AI fallback only when deterministic discovery found too few matches.
    ai_fallback = len(matches) == 0
    ai_results = []
    if ai_fallback:
        ai_results = _ai_fallback_recommendations(ingredients, preferences)

    return {
        "recipes": matches[:10],
        "source": "deterministic" if matches else "ai_fallback",
        "fallback": ai_fallback,
        "ai_results": ai_results,
        "fallback_warning": (
            "Hasil hanya dari AI (belum diverifikasi). Periksa resep sebelum memasak."
            if ai_fallback else None
        ),
        "sources": {
            "supabase_available": discovery["supabase_available"],
            "curated_count": discovery["curated_count"] + (len(seed_matches) if not discovery["supabase_available"] else 0),
            "external_count": discovery["external_count"],
            "seed_catalog_used": not discovery["supabase_available"],
        },
        "detected_ingredients": _ingredients.normalize_ingredients(ingredients),
    }


def _ai_fallback_recommendations(ingredients, preferences):
    """Reuse the existing vision/AI scan pipeline as a last resort. Returns a
    list of recipe dicts (never exposes secrets)."""
    try:
        text = " ".join(str(i) for i in ingredients if isinstance(i, str))
        names = _ingredients.normalize_ingredients(ingredients)
        cards = lookup_recipe_cards(names, ingredients)
        out = []
        for c in cards:
            out.append({
                "title": c.get("nama", ""),
                "image_url": c.get("thumbnail", ""),
                "source_url": c.get("url", ""),
                "source_type": "external",
                "source_name": "TheMealDB",
                "verified": False,
                "attribution_text": "Recipe data & image from TheMealDB (themealdb.com).",
            })
        return out
    except Exception as e:
        sys.stderr.write(f"AI fallback error: {e}\n")
        return []


def search_discovery(query):
    """GET /api/recipes/search?q=... — search curated seed catalog + matched
    results by title/cuisine. Returns list of normalized recipes."""
    query = (query or "").strip().lower()
    seeded = seed_data.seed_recipe_catalog()
    normalized = [recipe_discovery.normalize_recipe(r) for r in seeded]
    if not query:
        return normalized[:20]
    out = []
    for r in normalized:
        hay = " ".join([
            r.get("title", ""), r.get("cuisine", ""), r.get("country", ""),
            r.get("description", ""),
        ]).lower()
        if query in hay:
            out.append(r)
    return out[:20]


def get_recipe_by_id(recipe_id):
    """GET /api/recipes/<id> — single recipe by id from seed catalog or
    Supabase. Returns {'recipe': ...} or {'error': ...}."""
    recipe_id = (recipe_id or "").strip()
    for r in seed_data.seed_recipe_catalog():
        if r.get("id") == recipe_id or r.get("external_id") == recipe_id:
            return {"recipe": recipe_discovery.normalize_recipe(r)}
    sup = recipe_discovery.SupabaseRecipeProvider()
    if sup.client.is_configured():
        found = sup.client.get_recipe(recipe_id)
        if found:
            return {"recipe": recipe_discovery.normalize_recipe(found)}
    return {"error": "Recipe tidak ditemukan."}


def parse_recipe(raw):
    if not raw:
        raise RuntimeError("Resep AI kosong. Coba foto ulang.")
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        import re
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"```\s*$", "", cleaned, flags=re.IGNORECASE)
        cleaned = cleaned.strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(cleaned[start : end + 1])
            except json.JSONDecodeError:
                pass
        raise RuntimeError("Format respon AI tidak valid. Coba foto ulang dengan pencahayaan lebih baik.")


class BoundedHTTPServer(http.server.ThreadingHTTPServer):
    """Reject excess connections before allocating another request thread."""

    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self._request_slots = threading.BoundedSemaphore(_int_env("MAX_REQUEST_THREADS", 16))
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self._request_slots.acquire(blocking=False):
            try:
                request.settimeout(1)
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\nRetry-After: 5\r\n\r\n")
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()


def main():
    print("=" * 60)
    print("  Resep in aja — Multi-Provider Local Server")
    print("=" * 60)
    print()

    active = get_active_providers()
    if not active:
        print("  ⚠️  BELUM ADA API KEY YANG DISET!")
        print()
        print("  Set minimal salah satu env var (atau edit CONFIG di server.py):")
        print("    export OPENAI_API_KEY=\"sk-...\"        # https://platform.openai.com")
        print("    export ANTHROPIC_API_KEY=\"sk-ant-...\" # https://console.anthropic.com")
        print("    export GEMINI_API_KEY=\"AIza...\"       # https://aistudio.google.com (GRATIS)")
        print("    export GROQ_API_KEY=\"gsk_...\"         # https://console.groq.com (GRATIS)")
        print("    export OPENROUTER_API_KEY=\"sk-or-...\" # https://openrouter.ai (GRATIS)")
        print("    export BIGMODEL_API_KEY=\"xxx.xxx\"     # https://open.bigmodel.cn (GRATIS)")
        print("    export SILICONFLOW_API_KEY=\"sk-...\" # https://siliconflow.cn (GRATIS, DeepSeek-VL2)")
        print()
        print("  Pilih provider utama (opsional):")
        print("    export PROVIDER=gemini   # auto = pakai yang pertama tersedia")
        print()
        print("  Server tetap jalan — set API key lalu restart.")
        print()
    else:
        print(f"  Provider aktif: {', '.join(active)}")
        for p in active:
            print(f"    • {PROVIDERS[p]['label']:<22} → {CONFIG[p]['model']}")
        print()
        chain = choose_provider_chain()
        print(f"  Provider utama : {chain[0] if chain else '-'}")
        print(f"  Auto-fallback  : {' → '.join(chain[1:]) if len(chain) > 1 else '(tidak ada)'}")
        print()

    print(f"  Server : http://localhost:{PORT}")
    print(f"  Health : http://localhost:{PORT}/health")
    print()
    print("  Tekan Ctrl+C untuk berhenti.")
    print("=" * 60)
    print()

    try:
        http.server.ThreadingHTTPServer.allow_reuse_address = True
        # Bind to localhost by default (Priority 14). Only expose 0.0.0.0 when
        # explicitly requested (deployment behind a proxy sets HOST=0.0.0.0).
        bind_host = os.environ.get("HOST", "127.0.0.1")
        with BoundedHTTPServer((bind_host, PORT), Handler) as httpd:
            try:
                import subprocess
                url = f"http://localhost:{PORT}"
                if sys.platform == "darwin":
                    subprocess.Popen(["open", url])
                elif sys.platform.startswith("linux"):
                    subprocess.Popen(["xdg-open", url])
                elif sys.platform == "win32":
                    os.startfile(url)
            except Exception:
                pass
            if sys.platform == "win32" and sys.stdin.isatty():
                import threading
                import console_ui
                worker = threading.Thread(target=httpd.serve_forever, daemon=True)
                worker.start()
                try:
                    console_ui.run(CONFIG, PROVIDERS, PORT)
                finally:
                    httpd.shutdown()
                    worker.join(timeout=5)
            else:
                httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n\nServer dihentikan. Sampai jumpa! 👋")
        sys.exit(0)
    except OSError as e:
        if "Address already in use" in str(e):
            print(f"❌ Port {PORT} sudah dipakai. Coba: PORT=8788 python3 server.py")
        else:
            print(f"❌ Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()

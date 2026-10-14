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

Cara pakai:
  1. Set environment variable API key untuk provider yang kamu punya:
       export OPENAI_API_KEY="sk-..."
       export ANTHROPIC_API_KEY="sk-ant-..."
       export GEMINI_API_KEY="AIza..."
       export GROQ_API_KEY="gsk_..."
       export OPENROUTER_API_KEY="sk-or-..."
       export BIGMODEL_API_KEY="xxx.xxx"

     Atau edit langsung di file ini pada bagian KONFIGURASI di bawah.

  2. Pilih provider utama (default: auto — pakai yang pertama punya key):
       export PROVIDER=openai    # atau: anthropic, gemini, groq, openrouter, bigmodel, auto

  3. Jalankan:
       python3 server.py

  4. Buka http://localhost:8787 di browser.

  Auto-fallback: kalau provider utama gagal (rate limit, key invalid, dst),
  server otomatis coba provider lain yang punya key. Jadi selama minimal 1
  provider aktif, aplikasi tetap jalan.

Tidak butuh library tambahan — pure Python 3.8+ standard library.
"""

import http.server
import json
import os
import sys
import base64
import urllib.request
import urllib.error
from pathlib import Path

# Key diambil dari environment (jika diset) atau penyimpanan lokal terenkripsi.
from key_store import load_key
from recipe_sources import mixed_recipes

def provider_key(provider, env_name):
    return os.environ.get(env_name) or load_key(provider)


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
# Urutan: openai > anthropic > gemini > groq > openrouter > bigmodel > siliconflow
# Atau set manual: "openai", "anthropic", "gemini", "groq", "openrouter", "bigmodel", "siliconflow"
PREFERRED_PROVIDER = os.environ.get("PROVIDER", "auto").lower()

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
4. Langkah memasak: 4-7 langkah singkat, jelas, urutan logis, bahasa sehari-hari Indonesia.
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
def call_openai(data_url):
    cfg = CONFIG["openai"]
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
        "max_tokens": 1500,
    }
    return _http_json(
        cfg["base_url"],
        headers={
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
        },
        payload=payload,
        extract=lambda d: d["choices"][0]["message"]["content"],
    )


def call_anthropic(data_url):
    cfg = CONFIG["anthropic"]
    # Claude pakai format: messages + system terpisah
    # Image harus pakai base64 source (bukan URL)
    # data_url format: "data:image/jpeg;base64,XXXX" → split
    header, b64 = data_url.split(",", 1)
    media_type = header.split(":")[1].split(";")[0]  # e.g. "image/jpeg"

    payload = {
        "model": cfg["model"],
        "max_tokens": 1500,
        "system": SYSTEM_PROMPT,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": media_type, "data": b64},
                    },
                    {"type": "text", "text": USER_PROMPT},
                ],
            }
        ],
    }
    return _http_json(
        cfg["base_url"],
        headers={
            "x-api-key": cfg["api_key"],
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        payload=payload,
        extract=lambda d: d["content"][0]["text"],
    )


def call_gemini(data_url):
    cfg = CONFIG["gemini"]
    images = data_url if isinstance(data_url, list) else [data_url]
    # Gemini pakai: POST /models/{model}:generateContent
    # API key di query param
    url = f"{cfg['base_url']}/{cfg['model']}:generateContent?key={cfg['api_key']}"

    # Setiap foto dikirim sebagai bagian terpisah dalam satu permintaan Gemini.
    image_parts = []
    for image in images:
        header, b64 = image.split(",", 1)
        media_type = header.split(":")[1].split(";")[0]
        image_parts.append({"inlineData": {"mimeType": media_type, "data": b64}})

    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": USER_PROMPT},
                    *image_parts,
                ],
            }
        ],
        "generationConfig": {"maxOutputTokens": 1500},
    }
    return _http_json(
        url,
        headers={"Content-Type": "application/json"},
        payload=payload,
        extract=lambda d: d["candidates"][0]["content"]["parts"][0]["text"],
    )


def call_xai(data_url):
    """xAI Grok chat completions with a vision-capable model."""
    cfg = CONFIG["xai"]
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": USER_PROMPT},
                {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
            ]},
        ],
        "max_tokens": 1500,
    }
    return _http_json(
        cfg["base_url"],
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
        payload=payload,
        extract=lambda d: d["choices"][0]["message"]["content"],
    )


def call_groq(data_url):
    cfg = CONFIG["groq"]
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
        "max_tokens": 1500,
    }
    return _http_json(
        cfg["base_url"],
        headers={
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
        },
        payload=payload,
        extract=lambda d: d["choices"][0]["message"]["content"],
    )


def call_openrouter(data_url):
    cfg = CONFIG["openrouter"]
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
        "max_tokens": 1500,
    }
    return _http_json(
        cfg["base_url"],
        headers={
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
            # OpenRouter butuh header ini untuk tracking
            "HTTP-Referer": "http://localhost:8787",
            "X-Title": "Resep in aja",
        },
        payload=payload,
        extract=lambda d: d["choices"][0]["message"]["content"],
    )


def call_bigmodel(data_url):
    cfg = CONFIG["bigmodel"]
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
    }
    return _http_json(
        cfg["base_url"],
        headers={
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
        },
        payload=payload,
        extract=lambda d: d["choices"][0]["message"]["content"],
    )


def call_siliconflow(data_url):
    """SiliconFlow — akses DeepSeek-VL2, Qwen2-VL, InternVL, dst. OpenAI-compatible."""
    cfg = CONFIG["siliconflow"]
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
        "max_tokens": 1500,
        # SiliconFlow butuh flag ini untuk streaming vs non-streaming
        "stream": False,
    }
    return _http_json(
        cfg["base_url"],
        headers={
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
        },
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
    """Helper: POST JSON, return extracted text. Raise RuntimeError on error."""
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
        # Jangan kirim respons provider mentah ke browser: kadang memuat kredensial.
        raise RuntimeError(f"Provider AI mengembalikan HTTP {e.code}. Periksa key atau kuota di server.")
    except TimeoutError:
        raise RuntimeError("Provider AI tidak merespons dalam 25 detik. Coba lagi dengan foto lebih kecil.")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e.reason}")
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"Response parsing error: {e}")


def get_active_providers():
    """Return list of providers yang punya API key."""
    return [name for name in PROVIDERS if CONFIG[name]["api_key"]]


def choose_provider_chain():
    """Return list of provider names sesuai urutan prioritas."""
    active = get_active_providers()
    if not active:
        return []

    if PREFERRED_PROVIDER == "auto":
        # Urutan default: openai > anthropic > gemini > groq > openrouter > bigmodel > siliconflow
        priority = ["openai", "anthropic", "gemini", "groq", "openrouter", "bigmodel", "siliconflow"]
        return [p for p in priority if p in active]
    else:
        # Preferred dulu, sisanya sebagai fallback
        if PREFERRED_PROVIDER in active:
            others = [p for p in active if p != PREFERRED_PROVIDER]
            return [PREFERRED_PROVIDER] + others
        return active


def call_vision_with_fallback(data_url):
    """Coba provider sesuai urutan, fallback kalau gagal."""
    chain = choose_provider_chain()
    if not chain:
        raise RuntimeError(
            "Tidak ada API key yang dikonfigurasi. Set minimal salah satu: "
            "OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, "
            "OPENROUTER_API_KEY, BIGMODEL_API_KEY, atau SILICONFLOW_API_KEY."
        )

    errors = []
    last_provider = None
    for provider_name in chain:
        try:
            sys.stderr.write(f"  → Mencoba provider: {provider_name} ({CONFIG[provider_name]['model']})\n")
            content = PROVIDERS[provider_name]["call"](data_url)
            return provider_name, content
        except RuntimeError as e:
            err_msg = str(e)
            sys.stderr.write(f"    ✗ {provider_name} gagal: {err_msg[:150]}\n")
            errors.append(f"{provider_name}: {err_msg}")
            last_provider = provider_name
            continue

    raise RuntimeError(
        f"Semua provider gagal. Errors: {' | '.join(errors[:3])}"
    )


# =========================================================
# HTTP SERVER
# =========================================================
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self):
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
            active = get_active_providers()
            chain = choose_provider_chain()
            self.send_json({
                "ok": True,
                "active_providers": active,
                "preferred": PREFERRED_PROVIDER,
                "chain": chain,
                "models": {p: CONFIG[p]["model"] for p in active},
            })
        else:
            self.send_error(404, "Not found")

    def do_POST(self):
        if self.path == "/api/scan-resep":
            self.handle_scan()
        else:
            self.send_error(404, "Not found")

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
        self.end_headers()
        self.wfile.write(body)

    def handle_scan(self):
        try:
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self.send_json({"error": "Expected multipart/form-data"}, status=400)
                return

            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > 21 * 1024 * 1024:
                self.send_json({"error": "Request kosong atau terlalu besar (maks 20 MB foto)."}, status=413)
                return
            raw = self.rfile.read(length)
            images = self.parse_multipart_images(raw, content_type)

            if not images:
                self.send_json({"error": "Gambar tidak ditemukan dalam request."}, status=400)
                return

            if len(images) > 5 or sum(len(data) for data, _ in images) > 20 * 1024 * 1024:
                self.send_json({"error": "Maksimal 5 foto, total 20 MB."}, status=400)
                return
            data_urls = [f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
                         for data, mime in images]

            # Call vision API with fallback
            try:
                provider_used, raw_content = call_vision_with_fallback(data_urls if len(data_urls) > 1 else data_urls[0])
            except RuntimeError as e:
                err_msg = str(e)
                # Detect missing API key
                if "Tidak ada API key" in err_msg or "no API key" in err_msg.lower():
                    self.send_json({
                        "error": "Belum ada API key yang dikonfigurasi di server.py. "
                                 "Set minimal salah satu: OPENAI_API_KEY / ANTHROPIC_API_KEY / "
                                 "GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY / BIGMODEL_API_KEY / "
                                 "SILICONFLOW_API_KEY. "
                                 "Lihat README.md untuk cara dapat API key gratis."
                    }, status=500)
                else:
                    self.send_json({"error": err_msg}, status=502)
                return

            # Parse JSON dari content AI
            recipe = parse_recipe(raw_content)
            detected = recipe.get("bahanTerdeteksi", [])
            query = ingredient_query(detected)
            cards = mixed_recipes(query, search_cookpad, limit=18) if query else []
            if cards:
                recipe["menuAlternatif"] = [dict(card, recommended=i == 0) for i, card in enumerate(cards)]
            else:
                recipe["menuAlternatif"] = recommended_cards(detected) or lookup_recipe_cards(recipe.get("menuAlternatif", []), detected)
            self.send_json({
                "recipe": recipe,
                "provider": provider_used,
                "model": CONFIG[provider_used]["model"],
            })

        except Exception as e:
            sys.stderr.write(f"Server error: {e}\n")
            self.send_json({"error": f"Server error: {str(e)}"}, status=500)

    def parse_multipart_images(self, raw, content_type):
        from email.parser import BytesParser
        from email.policy import default

        message = BytesParser(policy=default).parsebytes(
            b"MIME-Version: 1.0\r\nContent-Type: " + content_type.encode("ascii", "ignore") +
            b"\r\n\r\n" + raw
        )
        images = []
        for part in message.iter_parts():
            mime = part.get_content_type().lower()
            if part.get_param("name", header="content-disposition") == "image" and mime in (
                "image/jpeg", "image/png", "image/webp", "image/gif"
            ):
                images.append((part.get_payload(decode=True), mime))
        return images

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

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


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


def ingredient_query(ingredients):
    import re
    words = []
    for item in ingredients if isinstance(ingredients, list) else []:
        text = str(item).lower()
        text = re.sub(r"\b(rasa|goreng|segar|bungkus|buah|potong|merk|kemasan)\b", " ", text)
        text = re.sub(r"[^a-z\s]", " ", text)
        for word in text.split():
            if len(word) > 2 and word not in words:
                words.append(word)
        if len(words) >= 4:
            break
    return " ".join(words[:4])


def recommended_cards(ingredients):
    text = " ".join(str(x).lower() for x in ingredients if isinstance(x, str))
    if "rendang" in text and any(x in text for x in ("indomie", "mie", "mi ")):
        # Relevansi: variasi dari bahan utama; bahan tambahan dicek di halaman resep.
        return [dict(card, recommended=i == 0) for i, card in enumerate(COOKPAD_RENDANG)]
    return []


def lookup_recipe_cards(names, ingredients=()):
    """Cari halaman resep sungguhan beserta thumbnail lewat indeks resep TheMealDB."""
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
                return cards
    return cards


def parse_recipe(raw):
    if not raw:
        raise RuntimeError("Respon AI kosong. Coba foto ulang.")
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
        with http.server.ThreadingHTTPServer(("0.0.0.0" if os.environ.get("RENDER") else "127.0.0.1", PORT), Handler) as httpd:
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

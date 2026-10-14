# Resep in aja — Zero-Waste Fridge AI 🍳 (Multi-Provider Local Version)

> **Purwarupa Hackathon Sustainability** — Ubah sisa bahan makanan jadi resep masakan Indonesia.
> Versi standalone multi-provider — pakai OpenAI / Claude / Gemini / Groq / OpenRouter / GLM / **DeepSeek-VL2 (via SiliconFlow)**. Bebas pilih!

## 🌈 Provider yang Didukung

| Provider | Model Default | Harga | Cara Dapat API Key |
|----------|---------------|-------|---------------------|
| **Google Gemini** ⭐ | `gemini-1.5-flash` | **GRATIS** (quota harian) | https://aistudio.google.com/apikey |
| **Groq** ⭐ | `llama-3.2-90b-vision-preview` | **GRATIS** (sangat cepat) | https://console.groq.com/keys |
| **BigModel (GLM)** ⭐ | `glm-4v-flash` | **GRATIS** (quota besar) | https://open.bigmodel.cn |
| **SiliconFlow** ⭐ | `deepseek-ai/deepseek-vl2` | **GRATIS** (~14M tokens) | https://siliconflow.cn |
| **OpenRouter** | `google/gemini-2.0-flash-exp:free` | GRATIS (banyak model) | https://openrouter.ai/keys |
| **Anthropic Claude** | `claude-3-5-sonnet-20241022` | $5 free credit | https://console.anthropic.com |
| **OpenAI** | `gpt-4o-mini` | Berbayar (~$0.15/1K img) | https://platform.openai.com/api-keys |

**Rekomendasi:** Pakai **Gemini**, **Groq**, atau **SiliconFlow (DeepSeek-VL2)** — gratis dan kualitas vision-nya bagus.

> 💡 **Note tentang DeepSeek:** API resmi DeepSeek (`api.deepseek.com`) belum support image input (cuma `deepseek-chat` & `deepseek-reasoner` text-only). Untuk pakai DeepSeek vision (DeepSeek-VL2), gunakan provider **SiliconFlow** di atas — mereka host DeepSeek-VL2 dengan API OpenAI-compatible + free tier.

## 🔐 Kelola API Key lewat CLI (Windows)

Jalankan perintah ini di terminal **mesin yang menjalankan `server.py`**. Input key tersembunyi (jangan taruh key sebagai argumen perintah):

```bash
python3 key_store.py set gemini       # Google Gemini
python3 key_store.py set openai       # ChatGPT / OpenAI API
python3 key_store.py set xai          # xAI Grok
python3 key_store.py set groq         # Groq (bukan Grok)
python3 key_store.py set openrouter   # Model dari OpenRouter
python3 key_store.py set anthropic    # Claude
python3 key_store.py set bigmodel     # GLM / Z.AI
python3 key_store.py set siliconflow
python3 key_store.py list             # sumber key, tanpa menampilkan isinya
python3 key_store.py remove gemini    # hapus key tersimpan lokal
```

Untuk provider/model lain yang kompatibel, gunakan key OpenRouter dan atur `OPENROUTER_MODEL` ke model vision yang tersedia. Server harus di-restart setelah perubahan key. Jika key juga ada di environment variable, **environment menang**; `remove` hanya menghapus key tersimpan lokal, bukan env var.

Key lokal disimpan dengan **Windows DPAPI** per akun Windows; SHA-256 hanya checksum, bukan enkripsi. Di Linux/macOS, aplikasi dapat membaca key dari environment/secret hosting, tetapi CLI `set` terenkripsi ini hanya berjalan di Windows. Jangan upload `.api-keys.enc.json` ke hosting lain. Pengguna web yang membuka server bersama tidak memiliki key atau pilihan provider masing-masing: **ini konfigurasi per instalasi/server**, bukan BYOK per pengunjung. Untuk pengguna lain memakai key mereka sendiri via CLI, mereka perlu menjalankan server sendiri pada akun/mesin mereka; deployment publik multi-user membutuhkan akun/login dan isolasi key terpisah.

## 🖥️ Menu terminal server

Saat `python3 server.py` dijalankan di terminal interaktif **Windows**, tampilan awal adalah dashboard status server dan provider aktif (bukan banjir log). Tekan `1` untuk **Setup key**: pilih provider dengan nomor, lalu tambah/ganti key, hapus key lokal dengan konfirmasi, atau lihat status tanpa melihat nilainya. Tekan `Ctrl+L` untuk berpindah **dashboard ↔ log terbaru**, dan `Q` untuk menghentikan server. Perubahan key lewat menu langsung aktif untuk permintaan berikutnya; environment variable tetap diprioritaskan dan tidak terhapus lewat menu. Di terminal non-interaktif/server Linux, server berjalan biasa dan log dicetak ke stderr.

## 🚀 Cara Pakai

### Langkah 1 — Install dependensi

Satu-satunya dependensi non-stdlib adalah **Pillow** (validasi/sanitasi gambar server-side). Install sebelum menjalankan:

```bash
python3 -m pip install -r requirements.txt
```

> Tanpa Pillow, server tetap jalan tapi **menolak semua scan foto** (HTTP 503) karena tidak bisa memvalidasi gambar dengan aman. Endpoint discovery/resep non-foto tetap berfungsi.

### Langkah 2 — Dapatkan API Key (Gratis)

Pilih salah satu provider di atas, daftar, dan buat API key. Formatnya beda-beda:
- **Gemini**: `AIzaSyA...` (panjang ~40 karakter)
- **Groq**: `gsk_abc...` (panjang ~100 karakter)
- **BigModel**: `id.secret` (ada titik di tengah)
- **OpenRouter**: `sk-or-v1-abc...`

### Langkah 3 — Konfigurasi

**Opsi A — Pakai file `.env` (rekomendasi):**
```bash
cp .env.example .env
# Edit .env, isi minimal salah satu API key
```

**Opsi B — Set env var langsung:**
```bash
# Mac/Linux
export GEMINI_API_KEY="AIza..."
./start.sh

# Windows (PowerShell)
$env:GEMINI_API_KEY="AIza..."
.\start.bat
```

### Langkah 4 — Jalankan

**Mac/Linux:**
```bash
./start.sh
```

**Windows:**
```bash
start.bat   # atau klik dua kali
```

Server otomatis membuka browser ke **http://localhost:8787**. Tinggal foto bahan makanan → dapat resep!

## 🔄 Multi-Provider & Auto-Fallback

Isi **lebih dari satu API key** untuk dapat auto-fallback. Contoh `.env`:

```env
GEMINI_API_KEY=AIza...
GROQ_API_KEY=gsk_...
BIGMODEL_API_KEY=xxx.xxx
```

Saat scan, server akan coba provider satu per satu (default urutan: OpenAI → Anthropic → Gemini → xAI → Groq → OpenRouter → BigModel → SiliconFlow). Kalau satu gagal (rate limit, key invalid, down), otomatis pindah ke berikutnya.

> ⚠️ **Privacy default:** fallback antar provider **nonaktif secara default**. Foto hanya dikirim ke provider utama/pilihan, kecuali pengguna meng-opt-in. Frontend mengirim field `allowFallback` per request; operator juga bisa mengaktifkan global lewat `ALLOW_CROSS_PROVIDER_FALLBACK=true`. Mengaktifkan fallback berarti foto bisa dikirim ke lebih dari satu provider — pertimbangkan privasi pengguna.

**Pilih provider utama manual:**
```env
PROVIDER=gemini   # pakai Gemini duluan, fallback ke lainnya kalau gagal
```

Endpoint `/health` untuk cek status:
```bash
curl http://localhost:8787/health
# → {"ok": true, "active_providers": ["gemini", "groq"], "preferred": "auto", ...}
```

## 📁 Isi Package

```
resep-in-aja-local/
├── resep-in-aja.html    # UI aplikasi (mobile-first, tema amber/orange)
├── server.py            # Multi-provider proxy server (Python 3.8+, stdlib + Pillow)
├── recipe_discovery.py  # Discovery deterministic + provider adapters
├── ingredients.py       # Normalisasi bahan multilingual + alias
├── seed_data.py         # Katalog resep asli internasional (offline)
├── supabase_client.py   # Adapter Supabase REST (anon key + RLS)
├── supabase_schema.sql  # Migrasi tabel + RLS + seed (jalankan manual)
├── recipe_sources.py    # Adapter scraping legacy (terisolasi dari discovery)
├── start.sh             # Quick start Mac/Linux (auto-load .env)
├── start.bat            # Quick start Windows
├── .env.example         # Template config semua provider
└── README.md            # File ini
```

## 🛠️ Cara Kerja Multi-Provider

1. Browser POST foto ke `/api/scan-resep` di localhost
2. `server.py` pilih provider berdasarkan `PROVIDER` env var (default: auto)
3. Provider pertama yang punya key dicoba duluan:
   - **OpenAI/Claude/Groq/OpenRouter**: format OpenAI-compatible (image_url base64)
   - **Anthropic**: format Claude (image source base64 + system terpisah)
   - **Gemini**: format Google (inlineData + systemInstruction)
   - **BigModel**: format GLM (mirip OpenAI)
4. Kalau gagal (HTTP 4xx/5xx/network error), coba provider berikutnya
5. Response AI diparse JSON → tampilkan resep + badge provider yang dipakai

## 🔒 Kontrak Upload / API (untuk frontend)

Nilai-nilai ini adalah **sumber kebenaran tunggal** untuk frontend — hard-coded
di `server.py` dan hanya bisa diubah lewat env var yang tercantum. Frontend
harus mematuhi batas ini sebelum mengirim, dan membaca pesan error yang
dikembalikan server (field `error`, `retryAfterSeconds`).

| Konfigurasi | Nilai default | Env var |
|---|---|---|
| Max file per scan | `MAX_FILES = 5` | — |
| Max byte per file | `MAX_BYTES_PER_FILE = 4 MB` | — |
| Max total byte | `MAX_TOTAL_BYTES = 12 MB` | — |
| Max dimensi gambar | `MAX_IMAGE_WIDTH/HEIGHT = 4096` | — |
| Max piksel terdekode | `MAX_DECODED_PIXELS = 16,000,000 px` | — |
| Rate limit per IP | 5 req / 60 detik | `SCAN_RATE_LIMIT_REQUESTS`, `SCAN_RATE_LIMIT_WINDOW_SECONDS` |
| Concurrency scan | `MAX_CONCURRENT_SCANS = 2` | `MAX_CONCURRENT_SCANS` |
| Deadline total scan | `SCAN_DEADLINE_SECONDS = 120` | `SCAN_DEADLINE_SECONDS` |
| Fallback antar provider | **nonaktif (default)** | opt-in per-request (`allowFallback` form field) atau `ALLOW_CROSS_PROVIDER_FALLBACK=true` |

- **Endpoint**: `POST /api/scan-resep` (multipart/form-data, field `image`).
  Setiap gambar divalidasi + di-sanitize server-side dengan Pillow (signature,
  dimensi, decompression-bomb) lalu di-re-encode ke JPEG sebelum dikirim ke
  provider AI — jangan anggap cek MIME di browser sebagai keamanan.
- **Kode error**: `400` (gambar/input tidak valid), `413` (terlalu besar),
  `429` (rate limit, ada `retryAfterSeconds`), `502` (semua provider gagal),
  `503` (belum ada API key / server sibuk), `504` (provider timeout).
- **Readiness**: `GET /health` mengembalikan `ready:false` + HTTP `503` saat
  tidak ada provider yang punya key. `GET /ready` = alias.
- **Keamanan**: server bind ke `127.0.0.1` secara default (env `HOST=0.0.0.0`
  hanya untuk deploy di belakang proxy). Tidak ada CORS wildcard; header
  `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, dan
  CSP nonce-free (default-src 'self') dipasang di semua respons. Origin/Host
  bisa dibatasi lewat `ALLOWED_ORIGINS` / `ALLOWED_HOSTS` (CSV).

## ❓ Troubleshooting

**"Tidak ada API key yang dikonfigurasi"**
→ Isi minimal salah satu API key di `.env` (lihat langkah 2)

**"Semua provider gagal"**
→ Cek `/health` untuk lihat provider aktif
→ Cek log server (terminal) untuk detail error per provider
→ Pastikan API key valid dan belum expired

**"Rate limit tercapai" (HTTP 429)**
→ Tunggu sebentar (quota harian reset otomatis)
→ Atau isi API key provider lain sebagai fallback

**"Photo tidak terdeteksi bahan"**
→ Foto ulang dengan pencahayaan lebih baik
→ Beberapa model (Claude) lebih sensitif ke format gambar — coba provider lain

**"Port 8787 sudah dipakai"**
→ `PORT=9000 python3 server.py`

## 🎨 Kustomisasi

**Ganti model** per provider via env var:
```bash
export GEMINI_MODEL=gemini-2.0-flash-exp     # model Gemini terbaru
export OPENAI_MODEL=gpt-4o                    # model OpenAI lebih powerful
export GROQ_MODEL=llama-3.2-11b-vision-preview  # model Groq lebih ringan
```

**Ganti warna tema**:
Edit variabel CSS di awal `<style>` di `resep-in-aja.html`.

**Ganti port**:
```bash
PORT=9000 python3 server.py
```

## 💡 Tips Memilih Provider

| Kebutuhan | Rekomendasi |
|-----------|-------------|
| **Demo hackathon, harus stabil** | Gemini + Groq (dua-duanya free, jadi fallback) |
| **Budget $0** | Gemini atau Groq saja sudah cukup |
| **Kualitas terbaik** | OpenAI GPT-4o atau Claude 3.5 Sonnet |
| **Speed tercepat** | Groq (inference di hardware LPU) |
| **Model open-source** | Groq Llama 3.2 atau OpenRouter ( banyak pilihan ) |
| **Akses banyak model dengan 1 key** | OpenRouter (aggregator) |

## 🏆 Hackathon Pitch Points

1. **Masalah:** Indonesia membuang 23-48 juta ton makanan/tahun (Bappenas)
2. **Solusi:** AI bantu manfaatkan sisa bahan kulkas jadi resep, bukan dibuang
3. **Tech:** Python + HTML + **Multi-provider AI Vision** (Gemini/Claude/GPT/Llama/GLM) — fleksibel, anti vendor lock-in
4. **Resilience:** Auto-fallback antar provider → 99% uptime walau satu API down
5. **Skalabilitas:** Bisa integrasi dengan e-commerce grocery (rekomendasi bahan kurang)
6. **Impact:** Kurangi food waste, hemat belanja, edukasi masak sehat

## 🔎 Recipe Discovery (Deterministic Matching)

Selain scan foto berbasis AI, aplikasi punya **discovery deterministic** yang
mencocokkan bahan (hasil scan ATAU masukan manual) ke katalog resep tanpa
memakai API berbayar.

**Urutan provider (sebelum AI fallback):**

1. **Supabase** — katalog resep komunitas (jika `SUPABASE_URL` + anon key diisi).
   RLS di `supabase_schema.sql` membatasi anon key ke resep publik saja.
2. **TheMealDB** — endpoint publik gratis (tanpa API key, `test` key = 1).
3. **Seed lokal** — katalog asli internasional (`seed_data.py`), selalu tersedia
   dan offline.
4. **AI fallback** — hanya jika tiga sumber di atas menghasilkan < 1 hasil;
   respons ditandai `fallback: true` + peringatan di UI.

**Pencocokan bahan deterministic:**
- Normalisasi multilingual (`ingredients.py`): `bawang putih` → `garlic`,
  `daging sapi` → `beef`, dst.
- Skor = proporsi bahan yang cocok; resep diurutkan berdasar skor + jumlah bahan
  kurang. Tidak pernah menampilkan resep acak yang tak berhubungan.

**Endpoint baru:**
```bash
# Cocokkan bahan (manual/scan) ke resep
curl -X POST http://localhost:8787/api/recipes/match \
  -H "Content-Type: application/json" \
  -d '{"ingredients":["telur","nasi","bawang putih"],
       "preferences":{"cuisine":"indonesian","diet":"vegetarian","maxTimeMinutes":30}}'

# Normalisasi nama bahan
curl -X POST http://localhost:8787/api/ingredients/normalize \
  -H "Content-Type: application/json" \
  -d '{"ingredients":["Bawang Putih","daging sapi"]}'

# Cari resep by id
curl http://localhost:8787/api/recipes/seed-indonesian-nasi-goreng
```

### Setup Supabase (opsional)

1. Buat project di https://supabase.com, ambil **anon** key (bukan service_role).
2. Jalankan `supabase_schema.sql` di SQL Editor (buat tabel + RLS + seed).
3. Isi `SUPABASE_URL` dan `SUPABASE_ANON_KEY` di `.env`.
4. Restart server. Tanpa Supabase, discovery tetap jalan via TheMealDB + seed lokal.

> ⚠️ **Isolasi scraping legacy:** `recipe_sources.py` memuat adapter scraping
> (Cookpad/Allrecipes/detik) untuk fitur lama. Modul discovery baru
> (`recipe_discovery.py`) **tidak** memakai scraping — hanya endpoint resmi
> (TheMealDB API + Supabase REST). Batasi pemakaian scraping legacy sesuai ToS
> sumber.

### Known limitations

- **TheMealDB stores metadata only.** TheMealDB's Terms of Use do not grant
  redistribution of recipe instruction prose or images, so the adapter stores
  only factual metadata (title, area, ingredient list, source link) and always
  links back to the original page. Full instructions and images are fetched
  live by the user on the source site — never copied or shipped.
- **Allergen tags are derived, not authoritative.** Allergens are inferred
  deterministically from the actual ingredient names (never from an LLM), with
  explicit false-positive suppression (e.g. "coconut milk" is not dairy,
  "peanut butter" is not dairy butter). The exclusion filter is **fail-closed**:
  a recipe with a positively-identified matching allergen is removed, AND a
  recipe with no ingredient data at all (unknown allergen metadata) is also
  removed when an exclusion is active — it is never silently passed as "safe".
  Always verify allergens before cooking.
- **`total_minutes` is derived** from `prep_minutes + cook_minutes` when a
  source omits it; a recipe with no time info leaves it `None` (treated as
  "unknown" by the time filter, never as 0).
- **AI fallback is unverified.** When deterministic sources yield nothing, the
  AI path is used and every result is labeled `verified: false` with a warning.
- **Nutrition (USDA) is estimate-only** and disabled by default
  (`ENABLE_NUTRITION_LOOKUP=false`); it is not a recipe source.

## ⚠️ Production / Deployment Caution

Server ini adalah **purwarupa hackathon**, bukan produk siap produksi. Sebelum
mengeksposnya ke internet (mis. `HOST=0.0.0.0` di belakang proxy), perhatikan
hal-hal berikut yang **belum** terselesaikan:

- **Tidak ada autentikasi / autorisasi.** Endpoint `/api/scan-resep` (yang
  mengonsumsi kuota AI berbayar) terbuka untuk siapa pun yang bisa mencapai
  port. Rate limit per-IP dan `ALLOWED_HOSTS`/`ALLOWED_ORIGINS` memitigasi
  sebagian, tetapi **bukan** pengganti login/API-key per pengguna.
- **Fallback privasi bersifat opt-in**, tapi begitu diaktifkan, foto pengguna
  dikirim ke semua provider dalam chain — pastikan ini sesuai kebijakan privasi
  dan regulasi (mis. UU PDP) Anda.
- **Penyimpanan key DPAPI hanya untuk Windows.** Di hosting Linux (Render dsb.)
  gunakan environment secrets; file `.api-keys.enc.json` tidak bisa didekripsi
  lintas mesin/akun.
- **`ThreadingHTTPServer` tanpa batas thread.** Python `ThreadingHTTPServer`
  membuat satu thread per koneksi; tidak ada hard cap global. Mitigasi utama
  adalah semaphore `MAX_CONCURRENT_SCANS` (scan AI) + rate limiter, tetapi
  koneksi lambat/keep-alive tetap bisa menahan thread. Untuk beban produksi
  pakai reverse proxy (nginx/caddy) + WSGI/ASGI server yang membatasi worker.
- **Timeouts provider relatif singkat** (25 dtk) dan deadline total scan 120 dtk
  — cocok untuk demo, tapi perlu tuning untuk beban nyata.

> **Rekomendasi:** untuk produksi, tambahkan lapisan autentikasi, isolasi key
> per pengguna, dan jalankan di belakang reverse proxy dengan batas koneksi.

## 🔁 Migrasi dari versi lama

- **Batas upload diseragamkan ke 4 MB/foto, 12 MB total, 16 juta piksel**
  (sebelumnya backend memakai 8 MB/20 MB). Frontend dan backend kini sejajar.
  Foto yang lolos batas lama (8–20 MB) kini ditolak — resize/kompresi foto Anda
  terlebih dahulu.
- **Fallback antar provider kini nonaktif secara default.** Jika Anda sebelumnya
  mengandalkan auto-fallback, set `ALLOW_CROSS_PROVIDER_FALLBACK=true` di `.env`
  (atau biarkan frontend meng-opt-in per request).
- **Pillow kini wajib** untuk scan foto: `python3 -m pip install -r requirements.txt`.
  Tanpa Pillow, scan foto mengembalikan HTTP 503 (discovery resep non-foto tetap jalan).

## 📝 Lisensi

MIT — bebas pakai untuk hackathon, demo, atau pengembangan lanjutan.

---

Dibuat untuk hackathon Sustainability. 🌱

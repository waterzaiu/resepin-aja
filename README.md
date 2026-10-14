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

### Langkah 1 — Dapatkan API Key (Gratis)

Pilih salah satu provider di atas, daftar, dan buat API key. Formatnya beda-beda:
- **Gemini**: `AIzaSyA...` (panjang ~40 karakter)
- **Groq**: `gsk_abc...` (panjang ~100 karakter)
- **BigModel**: `id.secret` (ada titik di tengah)
- **OpenRouter**: `sk-or-v1-abc...`

### Langkah 2 — Konfigurasi

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

### Langkah 3 — Jalankan

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

Saat scan, server akan coba provider satu per satu (default urutan: OpenAI → Anthropic → Gemini → Groq → OpenRouter → BigModel). Kalau satu gagal (rate limit, key invalid, down), otomatis pindah ke berikutnya.

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
├── resep-in-aja.html   # UI aplikasi (mobile-first, tema amber/orange)
├── server.py           # Multi-provider proxy server (Python 3.8+, stdlib only)
├── start.sh            # Quick start Mac/Linux (auto-load .env)
├── start.bat           # Quick start Windows
├── .env.example        # Template config semua provider
└── README.md           # File ini
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

## 📝 Lisensi

MIT — bebas pakai untuk hackathon, demo, atau pengembangan lanjutan.

---

Dibuat untuk hackathon Sustainability. 🌱

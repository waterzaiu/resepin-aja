# Resep in aja — Cloudflare Workers

Implementasi JavaScript/ES Modules untuk menjalankan UI dan API Resep in aja di Cloudflare Workers. Tidak ada dependensi npm runtime; Wrangler adalah dependensi pengembangan. Ini adalah alternatif deployment untuk backend Python, **bukan** pembungkus `server.py` dan bukan jaminan kesetaraan seluruh fitur Python.

## Arsitektur dan perbedaan dari Python

```text
Browser → Worker (src/index.js)
          ├─ ASSETS → public/ (HTML/CSS)
          ├─ ingredients.js + discovery.js + seed.js → pencocokan deterministik
          ├─ external.js → pencarian/kartu resep eksternal
          ├─ trends.js → RSS detikFood
          └─ gemini.js → API vision Gemini / OpenAI / Anthropic
```

- Worker memakai binding `ASSETS`, bukan server HTTP Python. Tidak perlu virtualenv atau instalasi paket Python.
- Katalog seed dan pencocokan ada dalam JavaScript. Tidak ada integrasi Supabase pada Worker (`supabase_configured: false`); cache sumber eksternal berada di memori isolate, bukan penyimpanan persisten.
- Worker membaca key dari environment/secrets, **bukan** penyimpanan key terenkripsi milik Python atau konsol pengelola key Python.
- Worker hanya mendukung tiga provider vision di atas. Urutan key aktif adalah **Gemini → OpenAI → Anthropic**. Walaupun `PROVIDER` dilaporkan sebagai `preferred` pada health, implementasi `buildProviderChain()` saat ini tidak mengubah urutan berdasarkan variabel tersebut.
- Validasi foto lebih terbatas daripada jalur Python dengan Pillow: Worker memeriksa ukuran, MIME, dan signature byte, tetapi **tidak** mendekode piksel, membatasi dimensi terdekode, menghapus EXIF/GPS, meratakan GIF, atau mengenkode ulang JPEG. Foto diteruskan apa adanya ke provider; hapus metadata sensitif sebelum mengunggah.

## Prasyarat

- Node.js **22 atau lebih baru** dan npm. Wrangler terpasang versi 4.151.0 mensyaratkan `node >=22.0.0`.
- Akun Cloudflare dan akses deployment hanya diperlukan untuk publikasi, bukan untuk unit test.
- Key provider vision hanya diperlukan untuk scan. Ketersediaan model, kuota, biaya API, dan batas Workers bergantung akun/provider; tidak ada jaminan layanan gratis.

## Setup dan pengembangan lokal

Jalankan dari root repositori (perintah shell berikut kompatibel dengan Bash/Git Bash):

```bash
cd cloudflare
npm ci
mkdir -p public
cp ../resep-in-aja.html public/index.html
npm run dev
```

`package-lock.json` mengunci hasil instalasi `npm ci`; rentang Wrangler pada `package.json` adalah `^4.151.0`, bukan versi eksak. Buka alamat lokal yang dicetak Wrangler (umumnya `http://localhost:8787`). `public/` adalah direktori staging aset: salin ulang HTML setelah mengubah frontend root, dan pastikan aset pendamping yang dirujuk HTML, misalnya `viral.css`, tersedia di sana. Jangan mengganti direktori aset menjadi root repositori.

Untuk mengaktifkan scan lokal:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars secara lokal: isi hanya key provider yang ingin dipakai.
npm run dev
```

Template menggunakan key kosong agar tidak mengaktifkan provider palsu. Tanpa key, pencarian seed dan normalisasi tetap berfungsi; galeri/RSS bergantung jaringan. `/health` dan `/ready` mengembalikan **503** jika tidak ada key, meskipun fitur non-AI masih dapat digunakan. Health hanya memeriksa keberadaan key, bukan validitas kredensial atau akses model.

### Alur penggunaan

1. Buka UI pada origin yang sama dengan Worker.
2. Cari resep atau masukkan bahan untuk pencocokan deterministik tanpa AI.
3. Untuk scan, pilih foto bahan; UI mengirim multipart ke `/api/scan-resep` dan Worker memanggil provider vision.
4. Periksa bahan terdeteksi, bahan yang kurang, serta langkah resep sebelum memasak. Hasil AI dan label alergen bukan nasihat keamanan pangan yang terjamin.

## Endpoint

| Metode | Path | Perilaku |
| --- | --- | --- |
| GET/HEAD | `/`, `/index.html`, path UI | Aset dari `ASSETS`; path UI tak dikenal memakai fallback SPA |
| GET | `/api/resep?q=ayam` | Galeri: pencarian Cookpad/ResepKoki, kurasi, dan fallback TheMealDB; bukan hanya API resmi |
| GET | `/api/inspirasi` | Galeri campuran dengan query bawaan dan fallback |
| GET | `/api/viral` | Resep terbaru dari RSS detikFood, bukan ukuran popularitas/viral |
| GET | `/api/recipes/search?q=telur` | Cari katalog seed; query kosong menampilkan katalog |
| GET | `/api/recipes/<id>` | Detail resep yang dikenali katalog |
| GET | `/health`, `/ready` | Status key/provider; 200 jika ada key, 503 jika tidak |
| POST | `/api/ingredients/normalize` | JSON `{"ingredients":["telur","ayam"]}` |
| POST | `/api/recipes/match` | JSON `{"ingredients":["telur"],"preferences":{}}`; maksimal 50 bahan |
| POST | `/api/scan-resep` | Multipart dengan field `image` berulang; memerlukan key vision |

RSS menyaring artikel resep bertanggal dalam jendela 60 hari, memakai cache per-isolate 5 menit, dan dapat mengembalikan cache lama berlabel `stale`. Tanpa data/cache yang dapat dipakai, endpoint mengembalikan 503 dengan `recipes: []`. Path API/health tidak masuk fallback HTML.

## Konfigurasi

Sumber konfigurasi: [`wrangler.jsonc`](wrangler.jsonc), [`src/index.js`](src/index.js), dan [`src/gemini.js`](src/gemini.js).

| Nama | Nilai/perilaku saat ini |
| --- | --- |
| `assets` | `./public`, binding `ASSETS`, `run_worker_first: true`, fallback `single-page-application` |
| `compatibility_date` | `2024-09-23`, dengan flag `nodejs_compat` |
| `PROVIDER` | `auto` pada konfigurasi; hanya metadata health, bukan pengatur urutan aktual |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` pada Wrangler; fallback kode jika tidak diisi adalah `gemini-1.5-flash` |
| `OPENAI_MODEL` | Fallback kode: `gpt-4o-mini` |
| `ANTHROPIC_MODEL` | Fallback kode: `claude-3-5-sonnet-latest` |
| `ALLOW_CROSS_PROVIDER_FALLBACK` | `false`; hanya string `true` mengaktifkan fallback global |
| `ENABLE_EXTERNAL_RECIPES` | `true`; string `false` mematikan provider eksternal/fallback di `/api/recipes/match`, **bukan** seluruh akses jaringan galeri, RSS, atau scan |
| `ALLOWED_HOSTS` | CSV hostname; kosong berarti tanpa pembatasan; hostname dan subdomainnya diterima |
| `ALLOWED_ORIGINS` | CSV origin lengkap, misalnya `https://contoh.example`; diperiksa pada POST jika header Origin tersedia, cocok persis |

Nama model di atas adalah nilai konfigurasi/kode, **bukan** konfirmasi bahwa model tersedia untuk akun Anda. Pilih model vision yang dapat diakses dan sesuai endpoint provider. Timeout panggilan provider vision adalah 30 detik.

Secrets: `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. Cukup isi salah satu; jangan menaruh nilai key di `wrangler.jsonc`, HTML, atau repositori. Konfigurasi nonrahasia dapat diatur di `vars`; key lokal di `.dev.vars`, key deployment melalui Wrangler secrets.

## Pengujian dan pemeriksaan lokal

```bash
npm test
# Opsional: bundle/validasi konfigurasi tanpa memublikasikan Worker
npx wrangler deploy --dry-run
```

`npm test` menjalankan `node --test test/*.test.js`, mencakup normalisasi, matching, galeri, RSS, routing aset, header keamanan, serta kontrak provider dengan fetch mock. Lulus unit test **tidak** membuktikan akses key/model, ketersediaan situs eksternal, atau deployment produksi.

Saat server lokal berjalan, contoh smoke test tanpa AI:

```bash
curl -i http://localhost:8787/health
curl 'http://localhost:8787/api/recipes/search?q=telur'
curl -X POST http://localhost:8787/api/ingredients/normalize \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["telur","ayam"]}'
```

## Deployment (jalankan hanya saat siap memublikasikan)

Pastikan staging `public/` terbaru dan tidak berisi data rahasia, lalu:

```bash
npx wrangler login
# Opsional, jika scan akan diaktifkan; masukkan key melalui prompt Wrangler:
npx wrangler secret put GEMINI_API_KEY
# Alternatif/tambahan:
# npx wrangler secret put OPENAI_API_KEY
# npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy --dry-run
npm run deploy
```

Deployment memakai nama `resepin-aja-workers` dan `workers_dev: true` dari konfigurasi; pastikan akun dan target benar sebelum menjalankan perintah yang mengubah layanan. `.dev.vars` bukan mekanisme konfigurasi secret produksi. Setelah publikasi, periksa URL yang dicetak Wrangler, UI, `/health`, dan endpoint non-AI. Uji scan hanya dengan persetujuan pengiriman foto serta penggunaan kuota provider.

## Keamanan dan batasan

- Tidak ada autentikasi atau rate limiter aplikasi pada Worker ini. Jangan mengandalkan klaim rate limit dari backend Python: lindungi endpoint publik dengan autentikasi, kontrol kuota, dan pembatasan trafik sebelum penggunaan produksi.
- `ALLOWED_HOSTS`/`ALLOWED_ORIGINS` bukan autentikasi. POST tanpa Origin tetap diterima; Worker tidak menyediakan header CORS untuk integrasi browser lintas origin.
- Fallback lintas provider nonaktif secara default. Bisa diaktifkan secara global atau melalui field multipart `allowFallback=true`; ini dapat mengirim foto ke provider lain yang memiliki key aktif. Menonaktifkan field per-request tidak membatalkan pengaktifan global.
- Upload: maksimal 5 foto, masing-masing 4 MiB, total 12 MiB; MIME JPEG/PNG/WebP/GIF dengan pemeriksaan signature, bukan verifikasi piksel penuh. Body dibaca ke memori sebelum pengecekan ukuran; batas platform tetap berlaku.
- HTML diberi CSP dan izin kamera same-origin; CSP masih mengizinkan inline script/style. API memakai header keamanan yang membatasi izin kamera. Ini bukan pengganti audit keamanan.
- Jangan commit `.dev.vars`, varian secret lokal, `.env`, atau penyimpanan key terenkripsi root. `.dev.vars.example` sengaja aman untuk dibagikan; periksa aturan ignore sebelum menambahkannya. Jangan salin secret ke `public/` karena aset tersebut dipublikasikan.
- Sumber eksternal dapat gagal, berubah markup, atau membatasi akses. Patuhi ketentuan sumber dan atribusinya; hasil kosong bukan alasan untuk mengarang data. Tidak ada jaminan biaya nol atau kesetaraan fitur penuh dengan Python.

Lihat implementasi keamanan di [`src/security.js`](src/security.js), discovery di [`src/discovery.js`](src/discovery.js), sumber galeri di [`src/external.js`](src/external.js), dan feed bertanggal di [`src/trends.js`](src/trends.js).

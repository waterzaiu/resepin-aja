# Panduan kontribusi

## Mulai dari mana?

- [README](README.md): pengenalan, alur aplikasi, dan setup Python.
- [Cloudflare Workers](cloudflare/README.md): runtime JavaScript dan deployment Worker.
- [Konsep awal](IDEA.md): konteks ide hackathon, bukan spesifikasi implementasi terkini.

## Tata letak repository

Frontend utama adalah `resep-in-aja.html`. Backend lokal ada di `server.py` dengan modul Python di root. Implementasi Cloudflare terpisah di `cloudflare/src/`; keduanya harus mempertahankan kontrak API yang dipakai frontend.

File Python dan pengujian root sengaja belum dipindahkan: launcher, impor, dan sejumlah harness menggunakan lokasi tersebut. Jangan memindahkan file hanya untuk merapikan tampilan tanpa memperbarui dan menguji seluruh referensinya.

| Area | Lokasi | Perhatian saat mengubah |
| --- | --- | --- |
| Antarmuka | `resep-in-aja.html` | Upload, kamera, pencarian, status kosong/error, aksesibilitas |
| Server lokal | `server.py` | Kontrak HTTP, keamanan gambar, pilihan provider |
| Discovery | `recipe_discovery.py`, `ingredients.py`, `seed_data.py` | Alias bahan, scoring, filter, sumber resep |
| Integrasi | `supabase_client.py`, `recipe_sources.py` | Timeout, validasi URL, atribusi sumber |
| Key lokal | `key_store.py`, `console_ui.py` | Jangan log atau tampilkan nilai key |
| Worker | `cloudflare/src/` | Perubahan Python tidak otomatis berlaku di Worker |
| Pengujian | `test_*.py`, `test_frontend*.js`, `cloudflare/test/` | Tambahkan regresi sesuai area perubahan |

## Pemeriksaan sebelum mengirim perubahan

Gunakan interpreter Python yang sama untuk instalasi dependensi dan pengujian:

```bash
python -m pip install -r requirements.txt
python -m unittest discover -s . -p "test_*.py"
node test_frontend.js
node test_frontend_manual_match.js
node test_frontend_inspiration.js
```

Untuk Worker:

```bash
cd cloudflare
npm ci
npm test
```

Harness Node di root menggunakan stub DOM; itu bukan pengganti tes browser nyata. `test_frontend_browser.cjs` membutuhkan Playwright beserta Chromium, serta server yang sudah berjalan. Dependensi Playwright tidak dipasang oleh `requirements.txt` atau paket Worker. Harness tersebut memakai respons API fixture, bukan bukti keberhasilan panggilan AI langsung.

## Aturan perubahan

1. Buat perubahan kecil dan terfokus; sertakan tes regresi untuk perbaikan bug.
2. Jika kontrak API berubah, periksa kedua backend dan frontend.
3. Perbarui dokumentasi konfigurasi ketika menambahkan environment variable.
4. Jangan commit `.env`, `.dev.vars`, key terenkripsi, dependency folder, atau hasil build. Template `.env.example` dan `.dev.vars.example` harus berisi placeholder saja.
5. File `probe*.mjs` di root adalah eksperimen lokal yang diabaikan Git; pengujian permanen harus masuk suite bernama `test_*` atau `cloudflare/test/`.
6. Jangan mengklaim hasil AI terverifikasi, bebas alergen, atau aman dikonsumsi tanpa pemeriksaan manusia.

## Melaporkan masalah

Sertakan runtime yang dipakai (Python atau Worker), langkah reproduksi, hasil yang diharapkan, hasil aktual, serta status HTTP/log yang sudah dibersihkan dari informasi sensitif. Jangan lampirkan API key atau foto pribadi.

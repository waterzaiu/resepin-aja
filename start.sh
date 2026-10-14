#!/usr/bin/env bash
# Resep in aja — Quick Start (Mac/Linux)
# Klik dua kali atau jalankan: ./start.sh
set -e
cd "$(dirname "$0")"

echo "=========================================="
echo "  Resep in aja — Multi-Provider Server"
echo "=========================================="
echo

# Cek python
if command -v python3 &>/dev/null; then
  PY=python3
elif command -v python &>/dev/null; then
  PY=python
else
  echo "❌ Python tidak ditemukan. Install dari https://python.org"
  exit 1
fi

echo "Menggunakan: $($PY --version)"
echo

# Auto-load .env kalau ada
if [ -f .env ]; then
  echo "📥 Loading .env..."
  set -a
  source .env
  set +a
fi

echo "Buka browser ke http://localhost:8787 setelah server jalan."
echo "Tekan Ctrl+C untuk berhenti."
echo

exec $PY server.py

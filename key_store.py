"""Local Windows DPAPI key store. SHA-256 validates encrypted payload integrity."""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys

if os.name == "nt":
    import win32crypt
else:
    win32crypt = None

ROOT = Path(__file__).resolve().parent
STORE = ROOT / ".api-keys.enc.json"


def _read_store():
    if not STORE.exists():
        return {}
    data = json.loads(STORE.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Format key store tidak valid")
    return data


def load_key(provider):
    entry = _read_store().get(provider)
    if not entry:
        return ""
    if win32crypt is None:
        raise RuntimeError("Key terenkripsi DPAPI hanya dapat dibuka oleh akun Windows asal; pakai env var pada hosting Linux")
    encrypted = base64.b64decode(entry["ciphertext"], validate=True)
    if hashlib.sha256(encrypted).hexdigest() != entry["sha256"]:
        raise ValueError("Checksum key terenkripsi tidak cocok")
    return win32crypt.CryptUnprotectData(encrypted, None, None, None, 0)[1].decode("utf-8")


def save_key(provider, key):
    if win32crypt is None:
        raise RuntimeError("Penyimpanan terenkripsi CLI memerlukan Windows DPAPI; di Linux gunakan secret environment")
    if not key.strip():
        raise ValueError("API key kosong")
    data = _read_store()
    encrypted = win32crypt.CryptProtectData(key.strip().encode("utf-8"), None, None, None, None, 0)
    data[provider] = {
        "ciphertext": base64.b64encode(encrypted).decode("ascii"),
        "sha256": hashlib.sha256(encrypted).hexdigest(),
    }
    temporary = STORE.with_name(STORE.name + ".tmp")
    try:
        temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, STORE)
    finally:
        temporary.unlink(missing_ok=True)
    if load_key(provider) != key.strip():
        raise RuntimeError("Verifikasi key gagal")


PROVIDERS = ("gemini", "openai", "xai", "anthropic", "groq", "openrouter", "bigmodel", "siliconflow")
ENV_NAMES = {p: p.upper() + "_API_KEY" for p in PROVIDERS}


def remove_key(provider):
    data = _read_store()
    if provider not in data:
        return False
    del data[provider]
    temporary = STORE.with_name(STORE.name + ".tmp")
    try:
        temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, STORE)
    finally:
        temporary.unlink(missing_ok=True)
    return provider not in _read_store()


def list_keys():
    saved = _read_store()
    for provider in PROVIDERS:
        env_name = ENV_NAMES[provider]
        source = "environment (prioritas)" if os.environ.get(env_name) else "DPAPI" if provider in saved else "belum ada"
        if provider == "bigmodel" and os.environ.get("ZAI_API_KEY"):
            source = "environment (ZAI_API_KEY, prioritas)"
        print(f"{provider:12} {source}")


def migrate_gemini():
    old = ROOT / ".gemini-key"
    if not old.exists():
        print("Tidak ada .gemini-key untuk dimigrasikan")
        return
    key = old.read_text(encoding="utf-8").strip()
    save_key("gemini", key)
    # Plaintext dihapus hanya setelah hasil DPAPI diverifikasi.
    old.unlink()
    print("Gemini key dimigrasikan ke DPAPI; file plaintext dihapus. Restart server.py.")


if __name__ == "__main__":
    import argparse
    import getpass

    parser = argparse.ArgumentParser(description="Atur API key provider (nilai key tidak pernah ditampilkan)")
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("set", "remove"):
        sub.add_parser(command).add_argument("provider", choices=PROVIDERS)
    sub.add_parser("list")
    sub.add_parser("migrate-gemini")
    args = parser.parse_args()
    if args.command == "set":
        if not sys.stdin.isatty():
            parser.error("Jalankan di terminal interaktif supaya key tidak muncul di riwayat shell")
        save_key(args.provider, getpass.getpass("API key (input tersembunyi): "))
        print(f"{args.provider} tersimpan terenkripsi. Restart server.py.")
    elif args.command == "remove":
        removed = remove_key(args.provider)
        print(f"{args.provider}: {'key lokal dihapus' if removed else 'tidak ada key lokal'}. Restart server.py.")
        if os.environ.get(ENV_NAMES[args.provider]) or (args.provider == "bigmodel" and os.environ.get("ZAI_API_KEY")):
            print("Catatan: environment variable masih aktif; hapus env itu secara terpisah.")
    elif args.command == "list":
        list_keys()
    else:
        migrate_gemini()

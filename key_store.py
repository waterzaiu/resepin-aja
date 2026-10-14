"""Local Windows DPAPI key store. SHA-256 validates encrypted payload integrity.

On Windows, DPAPI is called via ctypes (no pywin32 requirement); pywin32 is used
if present. On non-Windows hosts, stored DPAPI entries are ignored with a
sanitized warning so startup and environment-key use never crash.
"""
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import sys

if os.name == "nt":
    import ctypes.wintypes

ROOT = Path(__file__).resolve().parent
STORE = ROOT / ".api-keys.enc.json"


def _win32_dpapi_protect(data):
    import ctypes.wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [
            ("cbData", ctypes.wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    buf = ctypes.create_string_buffer(data, len(data))
    in_blob = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    out_blob = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)
    ):
        raise OSError("CryptProtectData gagal")
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)


def _win32_dpapi_unprotect(blob):
    import ctypes.wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [
            ("cbData", ctypes.wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    buf = ctypes.create_string_buffer(blob, len(blob))
    in_blob = DATA_BLOB(len(blob), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    out_blob = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)
    ):
        raise OSError("CryptUnprotectData gagal")
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)


def _try_pywin32():
    try:
        import win32crypt  # noqa: F401
    except Exception:
        return None

    def protect(data):
        import win32crypt
        return win32crypt.CryptProtectData(data, None, None, None, None, 0)

    def unprotect(blob):
        import win32crypt
        return win32crypt.CryptUnprotectData(blob, None, None, None, 0)[1]

    return protect, unprotect


_PYWIN32 = _try_pywin32() if os.name == "nt" else None


def _protect(data):
    if os.name != "nt":
        raise RuntimeError("Penyimpanan terenkripsi CLI hanya tersedia di Windows; di Linux gunakan environment secret")
    if _PYWIN32 is not None:
        return _PYWIN32[0](data)
    return _win32_dpapi_protect(data)


def _unprotect(blob):
    if os.name != "nt":
        raise RuntimeError("Key terenkripsi DPAPI hanya dapat dibuka di Windows; pakai env var pada hosting Linux")
    if _PYWIN32 is not None:
        return _PYWIN32[1](blob)
    return _win32_dpapi_unprotect(blob)


def _read_store():
    if not STORE.exists():
        return {}
    data = json.loads(STORE.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Format key store tidak valid")
    return data


def load_key(provider):
    """Return the locally stored key for ``provider``, or "" if absent/unusable.

    On non-Windows hosts (e.g. Render/Linux) a stored DPAPI entry cannot be
    decrypted; it is ignored with a sanitized warning so startup continues.
    """
    entry = _read_store().get(provider)
    if not entry:
        return ""
    if os.name != "nt":
        sys.stderr.write(
            "[key_store] Abaikan key lokal '%s' (DPAPI hanya untuk Windows). "
            "Gunakan env var pada hosting Linux.\n" % provider
        )
        return ""
    try:
        encrypted = base64.b64decode(entry.get("ciphertext", ""), validate=True)
    except (ValueError, TypeError):
        sys.stderr.write("[key_store] Abaikan key lokal '%s': ciphertext tidak valid.\n" % provider)
        return ""
    if hashlib.sha256(encrypted).hexdigest() != entry.get("sha256"):
        sys.stderr.write("[key_store] Abaikan key lokal '%s': checksum tidak cocok.\n" % provider)
        return ""
    try:
        return _unprotect(encrypted).decode("utf-8")
    except Exception:
        sys.stderr.write("[key_store] Gagal membuka key lokal '%s' (DPAPI beda akun/mesin?).\n" % provider)
        return ""


def save_key(provider, key):
    if os.name != "nt":
        raise RuntimeError("Penyimpanan terenkripsi CLI memerlukan Windows DPAPI; di Linux gunakan secret environment")
    if not key.strip():
        raise ValueError("API key kosong")
    data = _read_store()
    encrypted = _protect(key.strip().encode("utf-8"))
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

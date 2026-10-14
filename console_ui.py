"""Small interactive Windows console dashboard for the recipe server."""
import getpass
import os
import sys
import threading
from collections import deque

import key_store


class LogStream:
    def __init__(self, stream, lines):
        self.stream = stream
        self.lines = lines
        self.pending = ""
        self.lock = threading.Lock()

    def write(self, text):
        with self.lock:
            self.stream.write(text)
            self.stream.flush()
            self.pending += text
            while "\n" in self.pending:
                line, self.pending = self.pending.split("\n", 1)
                self.lines.append(line.rstrip("\r"))
        return len(text)

    def flush(self):
        self.stream.flush()

    def isatty(self):
        return self.stream.isatty()


def run(config, providers, port):
    """Run on the main thread; the HTTP server runs in a daemon thread."""
    import msvcrt

    lines = deque(maxlen=200)
    original = sys.stderr
    sys.stderr = LogStream(original, lines)
    mode = "dashboard"

    def clear():
        os.system("cls")

    def dashboard():
        clear()
        active = [name for name in providers if config[name]["api_key"]]
        print("RESEP IN AJA  |  Dashboard")
        print("=" * 48)
        print(f"Server: http://localhost:{port}   |   Status: berjalan")
        print("Provider aktif: " + (", ".join(active) if active else "belum ada"))
        print("\n[1] Setup key     [Ctrl+L] Log     [Q] Keluar")
        print("\nKey yang diubah langsung berlaku untuk scan berikutnya.")

    def logs():
        clear()
        print("RESEP IN AJA  |  Log (20 baris terakhir)")
        print("=" * 48)
        for line in list(lines)[-20:]:
            print(line)
        print("\n[Ctrl+L] Dashboard     [1] Setup key     [Q] Keluar")

    def choose_provider():
        print("\nPilih provider:")
        saved = key_store._read_store()
        for index, name in enumerate(key_store.PROVIDERS, 1):
            source = "env" if os.environ.get(key_store.ENV_NAMES[name]) else "tersimpan" if name in saved else "kosong"
            print(f"  {index}. {name:<12} ({source})")
        print("  0. Kembali")
        choice = input("Nomor provider: ").strip()
        if choice == "0":
            return None
        if not choice.isdecimal() or not 1 <= int(choice) <= len(key_store.PROVIDERS):
            print("Nomor tidak valid. Tekan Enter.")
            input()
            return None
        return key_store.PROVIDERS[int(choice) - 1]

    def setup():
        clear()
        print("SETUP API KEY — hanya mengubah key di server ini")
        print("[1] Tambah / ganti key   [2] Hapus key   [3] Lihat status   [0] Kembali")
        choice = input("Pilihan: ").strip()
        if choice == "3":
            key_store.list_keys()
        elif choice in ("1", "2"):
            name = choose_provider()
            if name is None:
                return
            if choice == "1":
                value = getpass.getpass(f"Key {name} (tidak tampil): ").strip()
                if not value:
                    print("Batal: key kosong.")
                else:
                    key_store.save_key(name, value)
                    config[name]["api_key"] = os.environ.get(key_store.ENV_NAMES[name]) or (os.environ.get("ZAI_API_KEY") if name == "bigmodel" else None) or value
                    print(f"Key {name} tersimpan" + ("; environment masih diprioritaskan." if config[name]["api_key"] != value else " dan aktif."))
            elif name in key_store._read_store():
                confirm = input(f"Ketik HAPUS untuk menghapus key {name}: ").strip()
                if confirm == "HAPUS":
                    key_store.remove_key(name)
                    config[name]["api_key"] = os.environ.get(key_store.ENV_NAMES[name], "")
                    if name == "bigmodel":
                        config[name]["api_key"] = config[name]["api_key"] or os.environ.get("ZAI_API_KEY", "")
                    print(f"Key lokal {name} dihapus.")
                else:
                    print("Batal.")
            else:
                print("Tidak ada key tersimpan untuk provider itu.")
            if os.environ.get(key_store.ENV_NAMES[name]) or (name == "bigmodel" and os.environ.get("ZAI_API_KEY")):
                print("Catatan: key environment masih aktif dan harus dihapus terpisah.")
        if choice != "0":
            input("Tekan Enter untuk kembali...")

    try:
        dashboard()
        while True:
            char = msvcrt.getwch()
            if char in ("\x00", "\xe0"):
                msvcrt.getwch()
                continue
            if char == "\x0c":
                mode = "dashboard" if mode == "logs" else "logs"
            elif char == "1":
                try:
                    setup()
                except (ValueError, OSError, RuntimeError) as exc:
                    print(f"Gagal: {exc}")
                    input("Tekan Enter untuk kembali...")
                mode = "dashboard"
            elif char.lower() == "q" or char == "\x03":
                break
            else:
                continue
            (logs if mode == "logs" else dashboard)()
    finally:
        sys.stderr = original

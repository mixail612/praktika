"""Check the built executable without touching user data or calling a paid API."""

import json
import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]


def main():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    opener = build_opener(ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix="praktika-smoke-") as folder:
        env = {**os.environ, "PRAKTIKA_DATA": folder, "PRAKTIKA_PORT": str(port)}
        process = subprocess.Popen(
            [str(ROOT / "dist/Praktika/Praktika.exe"), "--no-browser"],
            env=env,
            cwd=folder,
        )
        try:
            deadline = time.monotonic() + 45
            while True:
                if process.poll() is not None:
                    raise RuntimeError("Packaged process exited before startup")
                try:
                    with opener.open(f"http://127.0.0.1:{port}/api/health", timeout=2) as response:
                        assert json.load(response)["app"] == "praktika"
                    break
                except (OSError, URLError):
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Packaged application did not start") from None
                    time.sleep(0.2)
            for path in ("/", "/static/app.js", "/static/style.css", "/api/projects"):
                with opener.open(f"http://127.0.0.1:{port}{path}", timeout=5) as response:
                    assert response.status == 200
            print("Packaged application: startup, assets and isolated storage OK")
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)


if __name__ == "__main__":
    main()

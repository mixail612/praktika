"""Desktop entry point for Практика."""

import logging
import os
import socket
import sys
import threading
import time
import webbrowser

import uvicorn

from praktika.server import app
from praktika.storage import DATA


def main():
    port = int(os.environ.get("PRAKTIKA_PORT", "8765"))
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
        sock.listen(128)
    except OSError:
        import json
        import urllib.request

        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/health", timeout=2
            ) as response:
                if json.load(response).get("app") != "praktika":
                    raise ValueError("Port occupied")
            webbrowser.open(f"http://127.0.0.1:{port}")
            return
        except Exception:
            if sys.platform == "win32":
                import ctypes

                ctypes.windll.user32.MessageBoxW(
                    0, f"Порт {port} занят. Задайте другой PRAKTIKA_PORT.", "Практика", 0
                )
            return
    logging.basicConfig(filename=str(DATA / "app.log"), level=logging.INFO, encoding="utf-8")
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, access_log=False)
    )

    def open_browser():
        while not server.started and not server.should_exit:
            time.sleep(0.1)
        if server.started and "--no-browser" not in sys.argv:
            webbrowser.open(f"http://127.0.0.1:{port}")

    if sys.platform == "win32" and "--no-browser" not in sys.argv:
        import tkinter as tk
        from tkinter import ttk

        root = tk.Tk()
        root.title("Практика")
        root.geometry("460x250")
        root.resizable(False, False)
        root.configure(bg="#ffffff")
        tk.Label(
            root, text="Практика", font=("Segoe UI", 24, "bold"), bg="#ffffff", fg="#2563eb"
        ).pack(pady=(25, 6))
        tk.Label(
            root,
            text="Мастерская учебных работ\nПриложение работает локально в браузере.",
            font=("Segoe UI", 11),
            bg="#ffffff",
        ).pack(pady=6)
        ttk.Button(
            root,
            text="Открыть приложение",
            command=lambda: webbrowser.open(f"http://127.0.0.1:{port}"),
        ).pack(pady=10)
        tk.Label(
            root,
            text="Закройте это окно, чтобы остановить сервер.\nДождитесь сохранения и завершения генерации.",
            bg="#ffffff",
            fg="#6b7280",
        ).pack()

        def stop():
            from praktika.generation import JOBS

            for job in list(JOBS.values()):
                job["cancel"].set()
            server.should_exit = True
            root.destroy()

        root.protocol("WM_DELETE_WINDOW", stop)
        threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True).start()
        threading.Thread(target=open_browser, daemon=True).start()
        root.mainloop()
        return
    threading.Thread(target=open_browser, daemon=True).start()
    try:
        server.run(sockets=[sock])
    finally:
        sock.close()


if __name__ == "__main__":
    main()

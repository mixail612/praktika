"""Exercise the running app through HTTP and a disposable compatible provider (no paid calls)."""

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

calls = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.respond(
            {"data": [{"id": "agent-test", "object": "model", "created": 0, "owned_by": "test"}]}
        )

    def respond(self, data):
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        assert self.headers.get("Authorization") == "Bearer agent-smoke-key"
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        calls.append(payload)
        content = json.loads(payload["messages"][1]["content"])
        assert content["files"][0]["text"] == "Файл для чата"
        if len(calls) == 1:
            answer = {
                "action": "read_url",
                "url": "https://docs.python.org/3/tutorial/datastructures.html",
            }
        else:
            assert "Data Structures" in payload["messages"][-1]["content"]
            answer = {
                "action": "finish",
                "message": "Добавил проверенное определение.",
                "edits": [
                    {
                        "type": "upsert_section",
                        "section": {
                            "id": content["work"]["sections"][0]["id"],
                            "blocks": [
                                {
                                    "type": "paragraph",
                                    "text": "Изменено агентом по материалам документации.",
                                }
                            ],
                        },
                    }
                ],
            }
        self.respond(
            {
                "id": "chatcmpl-agent",
                "object": "chat.completion",
                "created": 0,
                "model": "agent-test",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(answer, ensure_ascii=False),
                        },
                        "finish_reason": "stop",
                    }
                ],
            }
        )


provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=provider.serve_forever, daemon=True).start()
project = profile = None
with httpx.Client(
    base_url="http://127.0.0.1:" + (sys.argv[1] if len(sys.argv) > 1 else "8765"),
    trust_env=False,
    timeout=30,
) as client:

    def checked(method, url, **kwargs):
        response = client.request(method, url, **kwargs)
        response.raise_for_status()
        return response

    try:
        profile = checked(
            "POST",
            "/api/routers/connect",
            json={
                "name": "Agent smoke test",
                "base_url": f"http://127.0.0.1:{provider.server_port}/v1",
                "api_key": "agent-smoke-key",
            },
        ).json()["profile"]
        project = checked("POST", "/api/projects").json()
        project.update(
            profile_id=profile["id"],
            model="agent-test",
            sections=[
                {
                    "id": "smoke-section",
                    "title": "Определение",
                    "blocks": [{"type": "paragraph", "text": "Исходный текст"}],
                }
            ],
        )
        checked("PUT", "/api/projects/" + project["id"], json=project)
        attachment = checked(
            "POST", "/api/extract", files={"file": ("chat.txt", "Файл для чата".encode())}
        ).json()
        checked(
            "POST",
            "/api/projects/" + project["id"] + "/chat",
            json={
                "message": "Проверь по документации и исправь",
                "attachments": [attachment],
                "internet": True,
            },
        )
        for _ in range(120):
            job = checked("GET", "/api/projects/" + project["id"] + "/job").json()
            if job["status"] not in ("running", "cancelling"):
                break
            time.sleep(0.25)
        assert job["status"] == "complete", job
        saved = checked("GET", "/api/projects/" + project["id"]).json()
        assert saved["sections"][0]["blocks"][0]["text"].startswith("Изменено агентом")
        assert saved["chat"][-1]["sources"][0]["kind"] == "page"
        assert saved["chat"][0]["files"][0]["text"] == "Файл для чата"
        checked("GET", "/api/projects/" + project["id"] + "/export.docx")
        undone = checked("POST", "/api/projects/" + project["id"] + "/chat/undo").json()
        assert undone["sections"][0]["blocks"][0]["text"] == "Исходный текст"
        print("Agent smoke OK: SDK + file extraction + real web page + atomic edit + DOCX + undo")
    finally:
        if project:
            client.delete("/api/projects/" + project["id"])
        if profile:
            client.delete("/api/profiles/" + profile["id"])
        provider.shutdown()

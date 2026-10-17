"""Run against a real local server; the provider is a disposable HTTP stub."""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

requests = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        assert self.path == "/v1/models"
        if self.headers.get("Authorization") != "Bearer test-router-key":
            self.send_response(401)
            self.end_headers()
            return
        raw = json.dumps(
            {
                "object": "list",
                "data": [
                    {
                        "id": "mock",
                        "object": "model",
                        "created": 0,
                        "owned_by": "test",
                        "name": "Test Model",
                    }
                ],
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(payload)
        prompt = payload["messages"][-1]["content"]
        if "одним словом" in prompt:
            content = "OK"
        elif "Составь компактный план" in prompt:
            content = json.dumps(
                {"sections": [{"title": "Проверка API", "description": "Проверить ответ модели"}]},
                ensure_ascii=False,
            )
        else:
            content = json.dumps(
                {"blocks": [{"type": "paragraph", "text": "Ответ локальной тестовой модели."}]},
                ensure_ascii=False,
            )
        result = {
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 0,
            "model": "mock",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
        }
        raw = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


if __name__ == "__main__":
    import sys

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=10, trust_env=False) as client:
        assert client.get("/api/health").json()["app"] == "praktika"
        assert "Практика" in client.get("/").text
        assert "buildPreview" in client.get("/static/app.js").text
        result = client.post(
            "/api/routers/connect",
            json={
                "name": "Packaged smoke test",
                "base_url": f"http://127.0.0.1:{provider.server_port}/v1",
                "model": "mock",
                "api_key": "test-router-key",
            },
        )
        result.raise_for_status()
        profile = result.json()["profile"]
        assert profile["models"] == [{"id": "mock", "name": "Test Model"}]
        try:
            catalog = client.post("/api/models", json=profile)
            catalog.raise_for_status()
            assert catalog.json()["models"] == [{"id": "mock", "name": "Test Model"}]
            result = client.post(f"/api/profiles/{profile['id']}/test")
            result.raise_for_status()
            p = client.post("/api/projects").json()
            p["work_mode"] = "extended"
            p["formatting"]["conclusion"] = False
            p["topic"] = "Тест локального API"
            p["profile_id"] = profile["id"]
            p["model"] = "chosen-model"
            p["reasoning_effort"] = "high"
            client.put("/api/projects/" + p["id"], json=p).raise_for_status()
            try:
                for mode in ("plan", "full"):
                    client.post(
                        f"/api/projects/{p['id']}/generate", json={"mode": mode}
                    ).raise_for_status()
                    for _ in range(100):
                        job = client.get(f"/api/projects/{p['id']}/job").json()
                        if job["status"] not in ("running", "cancelling"):
                            break
                        time.sleep(0.05)
                    assert job["status"] == "complete", job
                work = client.get("/api/projects/" + p["id"]).json()
                assert (
                    work["sections"][0]["blocks"][0]["text"] == "Ответ локальной тестовой модели."
                )
                doc = client.get(f"/api/projects/{p['id']}/export.docx")
                doc.raise_for_status()
                assert doc.content.startswith(b"PK")
                assert len(requests) == 3
                assert requests[-1]["response_format"] == {"type": "json_object"}
                assert "temperature" not in requests[-1]
                assert requests[-1]["model"] == "chosen-model"
                assert requests[-1]["reasoning_effort"] == "high"
                print(
                    "PASS: packaged app, static assets, Windows keyring, actual OpenAI SDK HTTP, plan, full text, DOCX"
                )
            finally:
                client.delete("/api/projects/" + p["id"]).raise_for_status()
        finally:
            client.delete("/api/profiles/" + profile["id"]).raise_for_status()
    provider.shutdown()

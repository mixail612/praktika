import socket
import threading
import unittest
from unittest.mock import MagicMock, patch

import test_application
from fastapi.testclient import TestClient

from praktika import agent, generation, storage, web_tools
from praktika.models import Block, Profile, Project, Section
from praktika.server import app


class AgentTests(unittest.TestCase):
    wait_job = test_application.ApplicationTests.wait_job

    def setUp(self):
        self.client = TestClient(app)
        profile = storage.write("profiles", Profile(model="mock", allow_no_key=True))
        self.project = storage.write(
            "projects",
            Project(
                profile_id=profile.id,
                sections=[
                    Section(title="Первый", blocks=[Block(text="Исходный текст")]),
                    Section(title="Второй", blocks=[Block(text="Сохранить без изменений")]),
                ],
            ),
        )
        self.url = "/api/projects/" + self.project.id + "/chat"

    def test_research_edit_attachment_history_and_undo(self):
        section = self.project.sections[0]
        responses = [
            {"action": "search_web", "query": "определение"},
            {"action": "read_url", "url": "https://example.org/info"},
            {
                "action": "finish",
                "message": "Уточнил определение.",
                "edits": [
                    {
                        "type": "upsert_section",
                        "section": {
                            "id": section.id,
                            "blocks": [{"type": "paragraph", "text": "Проверенное определение"}],
                        },
                    }
                ],
            },
        ]
        with (
            patch.object(generation, "client_for", return_value=MagicMock()),
            patch.object(generation, "ask", side_effect=responses) as ask,
            patch.object(
                web_tools,
                "search_web",
                return_value={
                    "results": [{"url": "https://example.org/info", "title": "Источник"}]
                },
            ),
            patch.object(
                web_tools,
                "read_page",
                return_value={"url": "https://example.org/info", "text": "Определение"},
            ),
        ):
            response = self.client.post(
                self.url,
                json={
                    "message": "Уточни определение",
                    "attachments": [{"name": "notes.txt", "text": "Материал чата"}],
                },
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.wait_job(self.project.id)["status"], "complete")
            self.assertIn("Материал чата", ask.call_args_list[0].args[2][1]["content"])
        saved = storage.read("projects", self.project.id)
        self.assertEqual(saved.sections[0].blocks[0].text, "Проверенное определение")
        self.assertEqual(saved.sections[1], self.project.sections[1])
        self.assertEqual(saved.chat[-1]["sources"][-1]["kind"], "page")
        self.assertTrue(saved.agent_undo)
        response = self.client.post(self.url + "/undo")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(storage.read("projects", self.project.id).sections, self.project.sections)

    def test_invalid_edits_are_atomic(self):
        edits = [
            {"type": "delete_section", "id": self.project.sections[0].id},
            {"type": "set_fields", "fields": {"profile_id": "forbidden"}},
        ]
        with (
            patch.object(generation, "client_for", return_value=MagicMock()),
            patch.object(
                generation,
                "ask",
                return_value={"action": "finish", "message": "Ошибка", "edits": edits},
            ),
        ):
            self.client.post(self.url, json={"message": "Правки"})
            self.assertEqual(self.wait_job(self.project.id)["status"], "failed")
        self.assertEqual(storage.read("projects", self.project.id).sections, self.project.sections)

    def test_internet_disabled_and_followup_history(self):
        with (
            patch.object(generation, "client_for", return_value=MagicMock()),
            patch.object(
                generation,
                "ask",
                side_effect=[
                    {"action": "search_web", "query": "x"},
                    {"action": "finish", "message": "Без интернета", "edits": []},
                ],
            ),
            patch.object(web_tools, "search_web") as search,
        ):
            self.client.post(self.url, json={"message": "Вопрос", "internet": False})
            self.assertEqual(self.wait_job(self.project.id)["status"], "complete")
            search.assert_not_called()
        with (
            patch.object(generation, "client_for", return_value=MagicMock()),
            patch.object(
                generation,
                "ask",
                return_value={"action": "finish", "message": "Продолжаю", "edits": []},
            ) as ask,
        ):
            self.client.post(self.url, json={"message": "Продолжай"})
            self.assertEqual(self.wait_job(self.project.id)["status"], "complete")
            self.assertIn("Без интернета", ask.call_args.args[2][1]["content"])

    def test_cancel_preserves_document_and_blocks_conflicting_edits(self):
        entered, release = threading.Event(), threading.Event()

        def slow(*args):
            entered.set()
            release.wait(3)
            return {
                "action": "finish",
                "edits": [{"type": "delete_section", "id": self.project.sections[0].id}],
            }

        with (
            patch.object(generation, "client_for", return_value=MagicMock()),
            patch.object(generation, "ask", side_effect=slow),
        ):
            result = self.client.post(self.url, json={"message": "Удалить"}).json()
            self.assertTrue(entered.wait(2))
            self.assertEqual(
                self.client.put(
                    "/api/projects/" + self.project.id, json=self.project.model_dump()
                ).status_code,
                409,
            )
            self.assertEqual(self.client.post(self.url, json={"message": "Ещё"}).status_code, 400)
            self.client.post("/api/jobs/" + result["id"] + "/cancel")
            release.set()
            self.assertEqual(self.wait_job(self.project.id)["status"], "cancelled")
        self.assertEqual(storage.read("projects", self.project.id).sections, self.project.sections)

    def test_undo_refuses_to_overwrite_manual_changes(self):
        saved = self.project.model_copy(deep=True)
        saved.agent_undo = {"before": agent.snapshot(saved), "after": agent.snapshot(saved)}
        saved.sections[0].blocks[0].text = "Новая ручная правка"
        storage.write("projects", saved)
        self.assertEqual(self.client.post(self.url + "/undo").status_code, 400)
        self.assertEqual(
            storage.read("projects", saved.id).sections[0].blocks[0].text, "Новая ручная правка"
        )

    def test_reader_blocks_local_network_and_scripts(self):
        for address in ("127.0.0.1", "10.0.0.1", "::1", "169.254.169.254"):
            with patch.object(
                socket,
                "getaddrinfo",
                return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 80))],
            ):
                with self.assertRaises(ValueError):
                    web_tools.read_page("http://example.org")
        with patch.object(
            web_tools,
            "fetch",
            return_value=(
                "https://example.org",
                "<h1>Факты</h1><script>скрытый код</script><p>Текст</p>",
            ),
        ):
            page = web_tools.read_page("https://example.org")
            self.assertIn("Факты", page["text"])
            self.assertNotIn("скрытый код", page["text"])

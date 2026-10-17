"""Regression checks for shared services and publication boundaries."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from praktika import generation, storage
from praktika.migration import project_from_data
from praktika.models import Profile, Project
from scripts.package_source import ROOT, source_files


class SharedServicesTests(unittest.TestCase):
    def test_model_resolution_preserves_precedence_and_profile(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(storage, "DATA", Path(folder)):
            old = storage.write("profiles", Profile(model="old"))
            active = storage.write(
                "profiles", Profile(model="router-default", reasoning_effort="low")
            )
            storage.save_preferences({"profile_id": active.id, "model": "last-model"})
            work = Project(profile_id=old.id)
            resolved = generation.resolve_profile(work)
            self.assertEqual(
                (resolved.id, resolved.model, resolved.reasoning_effort),
                (active.id, "last-model", "low"),
            )
            work.model = " selected-model "
            work.reasoning_effort = "high"
            resolved = generation.resolve_profile(work)
            self.assertEqual(
                (resolved.model, resolved.reasoning_effort), ("selected-model", "high")
            )
            self.assertEqual(storage.read("profiles", active.id).model, "router-default")
            work.reasoning_effort = ""
            self.assertEqual(generation.resolve_profile(work).reasoning_effort, "")

    def test_shared_import_preserves_current_document_and_legacy_blocks(self):
        original = Project(title="Current")
        self.assertEqual(project_from_data(original.model_dump()), original)
        fixture = Path(__file__).parent / "fixtures/legacy_work.json"
        data = json.loads(fixture.read_text(encoding="utf-8"))
        project = project_from_data(data, "Imported")
        self.assertEqual(project.title, "Imported")
        self.assertEqual(
            [b.type for b in project.sections[0].blocks], ["paragraph", "paragraph", "table"]
        )
        self.assertEqual(project.sections[0].blocks[1].text, "Абзац прежнего формата.")

    def test_publication_excludes_personal_files_and_build_outputs(self):
        paths = {p.relative_to(ROOT).as_posix() for p in source_files()}
        self.assertIn("praktika/web/app.js", paths)
        self.assertIn("tests/fixtures/legacy_work.json", paths)
        self.assertIn("Praktika.spec", paths)
        self.assertIn(".github/workflows/ci.yml", paths)
        for path in paths:
            self.assertFalse(path.startswith(("dist/", "build/", "qa/", ".venv/")))
            self.assertNotIn(Path(path).suffix, {".docx", ".ttf", ".lnk", ".exe", ".log"})
            if Path(path).suffix == ".json":
                self.assertTrue(path.startswith("tests/fixtures/"))

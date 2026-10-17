import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

import keyring

from .models import Profile, Project

DATA = Path(
    os.environ.get(
        "PRAKTIKA_DATA", str(Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Praktika")
    )
)
DATA.mkdir(parents=True, exist_ok=True)
LOCK = threading.RLock()


def path_for(kind, identifier):
    if not re.fullmatch(r"[a-f0-9]{32}", identifier):
        raise ValueError("Некорректный идентификатор")
    folder = DATA / kind
    folder.mkdir(exist_ok=True)
    return folder / (identifier + ".json")


def write(kind, obj):
    with LOCK:
        if isinstance(obj, Project):
            obj.updated = datetime.now(timezone.utc).isoformat()
        path = path_for(kind, obj.id)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(obj.model_dump_json(indent=2), encoding="utf-8")
        temporary.replace(path)
    return obj


def read(kind, identifier):
    cls = Project if kind == "projects" else Profile
    return cls.model_validate_json(path_for(kind, identifier).read_text(encoding="utf-8"))


def listing(kind):
    folder = DATA / kind
    if not folder.exists():
        return []
    result = []
    for path in folder.glob("*.json"):
        try:
            result.append(read(kind, path.stem))
        except (ValueError, OSError):
            continue
    return sorted(
        result,
        key=lambda p: getattr(p, "updated", p.name if isinstance(p, Profile) else ""),
        reverse=True,
    )


def get_key(identifier):
    return keyring.get_password("Praktika", identifier) or ""


def save_key(identifier, value):
    keyring.set_password("Praktika", identifier, value)


def delete_key(identifier):
    try:
        keyring.delete_password("Praktika", identifier)
    except keyring.errors.PasswordDeleteError:
        pass


def preferences():
    with LOCK:
        path = DATA / "settings.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def save_preferences(values):
    with LOCK:
        current = preferences()
        current.update(values)
        path = DATA / "settings.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(current, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
        return current

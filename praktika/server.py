import json
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__, agent, generation, storage
from .documents import export_docx
from .materials import extract_attachment
from .migration import project_from_data
from .models import Profile, ProfileInput, Project, uid

app = FastAPI(title="Практика", docs_url=None, redoc_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])
WEB = Path(__file__).parent / "web"


@app.middleware("http")
async def local_origin(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and origin != f"{request.url.scheme}://{request.headers.get('host')}":
        return Response("Cross-origin requests are not allowed", 403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(FileNotFoundError)
async def missing(request, error):
    return Response("Объект не найден", 404)


@app.exception_handler(ValueError)
async def invalid(request, error):
    return Response(str(error), 400)


@app.get("/api/health")
def health():
    return {"app": "praktika", "version": __version__}


@app.get("/api/settings")
def settings():
    prefs = storage.preferences()
    available = storage.listing("profiles")
    if not any(p.id == prefs.get("profile_id") for p in available):
        recent = next(
            (
                p
                for p in storage.listing("projects")
                if any(r.id == p.profile_id for r in available)
            ),
            None,
        )
        prefs = storage.save_preferences(
            {
                "profile_id": recent.profile_id if recent else available[0].id if available else "",
                "model": recent.model if recent else "",
            }
        )
    return prefs


@app.put("/api/settings")
def update_settings(values: dict):
    allowed = {k: str(v) for k, v in values.items() if k in ("profile_id", "model")}
    if allowed.get("profile_id"):
        storage.read("profiles", allowed["profile_id"])
    return storage.save_preferences(allowed)


@app.get("/api/projects")
def projects():
    return [
        dict(id=p.id, title=p.title, topic=p.topic, updated=p.updated)
        for p in storage.listing("projects")
    ]


@app.post("/api/projects")
def create_project():
    prefs = storage.preferences()
    return storage.write(
        "projects",
        Project(
            work_mode="practical",
            profile_id=prefs.get("profile_id", ""),
            model=prefs.get("model", ""),
            formatting={"title_page": False, "conclusion": False},
        ),
    )


@app.get("/api/projects/{identifier}")
def get_project(identifier: str):
    return storage.read("projects", identifier)


@app.put("/api/projects/{identifier}")
def put_project(identifier: str, project: Project):
    if identifier != project.id:
        raise ValueError("Идентификаторы не совпадают")
    with storage.LOCK:
        job = generation.active(identifier)
        if job and job["status"] in ("running", "cancelling"):
            raise HTTPException(409, "Дождитесь окончания генерации или отмените её")
        prefs = storage.preferences()
        if prefs.get("profile_id"):
            project.profile_id = prefs["profile_id"]
        if project.model:
            storage.save_preferences({"model": project.model})
        return storage.write("projects", project)


@app.delete("/api/projects/{identifier}")
def delete_project(identifier: str):
    with storage.LOCK:
        job = generation.active(identifier)
        if job and job["status"] in ("running", "cancelling"):
            raise ValueError("Сначала остановите генерацию")
        storage.path_for("projects", identifier).unlink()
    return {"ok": True}


@app.get("/api/profiles")
def profiles():
    return [
        dict(**p.model_dump(), has_key=bool(storage.get_key(p.id)))
        for p in storage.listing("profiles")
    ]


@app.post("/api/profiles")
def save_profile(profile: ProfileInput):
    validate_endpoint(profile.base_url)
    if not (profile.api_key.strip() or storage.get_key(profile.id) or profile.allow_no_key):
        raise ValueError("Введите API-ключ роутера или явно выберите сервер без авторизации")
    if profile.api_key.strip():
        storage.save_key(profile.id, profile.api_key.strip())
    saved = storage.write("profiles", Profile.model_validate(profile.model_dump()))
    return dict(**saved.model_dump(), has_key=bool(storage.get_key(saved.id)))


def validate_endpoint(base_url):
    parsed = urlparse(base_url)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Укажите полный адрес API, например https://api.openai.com/v1")


@app.post("/api/models")
def available_models(profile: ProfileInput):
    """Use draft endpoint/key without saving the profile or returning credentials."""
    validate_endpoint(profile.base_url)
    if not (profile.api_key.strip() or storage.get_key(profile.id) or profile.allow_no_key):
        raise ValueError("Для загрузки списка моделей нужен API-ключ роутера")
    try:
        with generation.client_for(profile, api_key=profile.api_key.strip() or None) as client:
            # One catalogue response; do not follow untrusted pagination URLs.
            page = client.models.list(timeout=20)
            models = {}
            for model in page.data:
                if not isinstance(model.id, str) or not model.id.strip():
                    continue
                extra = model.model_extra or {}
                name = extra.get("name")
                models[model.id] = {
                    "id": model.id,
                    "name": name if isinstance(name, str) else model.id,
                }
            return {"models": sorted(models.values(), key=lambda m: m["id"].casefold())}
    except Exception as error:
        raise HTTPException(400, generation.friendly_error(error))


@app.post("/api/routers/connect")
def connect_router(profile: ProfileInput):
    try:
        result = available_models(profile)
        profile.models = result["models"]
        profile.catalog_supported = True
        message = (
            f"Роутер подключён. Доступно моделей: {len(profile.models)}. Выберите модель в работе."
        )
    except HTTPException as error:
        # Missing /models is compatible with manual model selection, auth failures are not.
        if error.detail not in (
            "Модель или адрес API не найдены.",
            "Ошибка API: HTTP 405. Проверьте параметры модели.",
            "Ошибка API: HTTP 501. Проверьте параметры модели.",
        ):
            raise
        profile.models = []
        profile.catalog_supported = False
        message = "Подключение сохранено. Роутер не предоставляет /models; укажите ID модели в работе. Генерация пока не проверена."
    saved = save_profile(profile)
    return {"profile": saved, "message": message}


@app.delete("/api/profiles/{identifier}")
def delete_profile(identifier: str):
    storage.path_for("profiles", identifier).unlink()
    storage.delete_key(identifier)
    return {"ok": True}


@app.post("/api/profiles/{identifier}/reveal-key")
def reveal_key(identifier: str):
    storage.read("profiles", identifier)
    return {"api_key": storage.get_key(identifier)}


@app.post("/api/profiles/{identifier}/test")
def test_profile(identifier: str):
    profile = storage.read("profiles", identifier)
    if not profile.model:
        return available_models(ProfileInput.model_validate(profile.model_dump()))
    try:
        with generation.client_for(profile) as client:
            args = {profile.token_parameter: 256}
            if profile.reasoning_effort:
                args["reasoning_effort"] = profile.reasoning_effort
            result = client.chat.completions.create(
                model=profile.model,
                messages=[{"role": "user", "content": "Ответь одним словом: OK"}],
                **args,
            )
            if not result.choices:
                raise ValueError("Пустой ответ")
        return {"message": "Модель отвечает. Подключение работает."}
    except Exception as error:
        raise HTTPException(400, generation.friendly_error(error))


@app.get("/api/projects/{identifier}/export.docx")
def docx(identifier: str):
    return Response(
        export_docx(storage.read("projects", identifier)),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": 'attachment; filename="practical-work.docx"'},
    )


@app.get("/api/projects/{identifier}/export.json")
def backup(identifier: str):
    return Response(
        storage.read("projects", identifier).model_dump_json(indent=2),
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="practical-work.json"'},
    )


@app.post("/api/import")
async def import_project(file: UploadFile):
    raw = await file.read(20_000_001)
    if len(raw) > 20_000_000:
        raise ValueError("Файл больше 20 МБ")
    data = json.loads(raw.decode("utf-8-sig"))
    project = project_from_data(data, Path(file.filename or "Импорт").stem)
    project.id = uid()
    return storage.write("projects", project)


@app.post("/api/extract")
async def extract(file: UploadFile):
    raw = await file.read(20_000_001)
    if len(raw) > 20_000_000:
        raise ValueError("Размер файла должен быть не более 20 МБ")
    return extract_attachment(file.filename, raw)


class GenerationRequest(BaseModel):
    mode: str
    section_id: str = ""


@app.post("/api/projects/{identifier}/chat")
def chat(identifier: str, request: agent.ChatRequest):
    return agent.start(identifier, request)


@app.post("/api/projects/{identifier}/chat/undo")
def undo_chat(identifier: str):
    return agent.undo(identifier)


@app.post("/api/projects/{identifier}/generate")
def generate(identifier: str, request: GenerationRequest):
    if request.mode not in ("plan", "full", "section"):
        raise ValueError("Неизвестный режим")
    return generation.start(identifier, request.mode, request.section_id)


@app.get("/api/projects/{identifier}/job")
def job(identifier: str):
    return generation.active(identifier)


@app.post("/api/jobs/{identifier}/cancel")
def cancel(identifier: str):
    with generation.GUARD:
        job = generation.JOBS.get(identifier)
        if not job:
            raise HTTPException(404, "Задача не найдена")
        if job["status"] == "running":
            job["cancel"].set()
            job["status"] = "cancelling"
            job["message"] = "Остановка: ожидаю завершения запроса. Его результат будет отброшен."
    return generation.public_job(job)


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


app.mount("/static", StaticFiles(directory=WEB), name="static")

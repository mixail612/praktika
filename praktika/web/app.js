"use strict";
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const uid = () => crypto.randomUUID().replaceAll("-", "");
$('#profile-form [name="temperature"]').parentElement.insertAdjacentHTML(
  "beforebegin",
  '<div class="grid2"><label>Параметр лимита токенов<select name="token_parameter"><option value="max_tokens">max_tokens (обычные модели)</option><option value="max_completion_tokens">max_completion_tokens (reasoning)</option></select></label><label>Передавать температуру<select name="send_temperature"><option value="false">Нет — значение модели</option><option value="true">Да — указанное ниже</option></select></label></div>',
);
let project = null,
  profiles = [],
  tab = "brief",
  sectionId = "",
  job = null,
  dirty = false,
  timer,
  saving = null,
  revision = 0,
  profileId = "";
let toastTimer;
let connecting = false,
  pendingGeneration = false,
  pendingAgent = false;
const chatDrafts = new Map();
let chatUploading = false;
function chatDraft() {
  if (!chatDrafts.has(project.id))
    chatDrafts.set(project.id, {
      message: "",
      files: [],
      internet: true,
      open: false,
    });
  return chatDrafts.get(project.id);
}
function safeWebLink(url) {
  try {
    const u = new URL(url);
    return ["http:", "https:"].includes(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
}
function agentPanel() {
  const draft = chatDraft(),
    model =
      project.model ||
      profiles.find((p) => p.id === project.profile_id)?.model ||
      "не выбрана";
  return `<details class="card agent-panel" ${draft.open ? "open" : ""}><summary>✧ Агент редактора</summary><div class="agent-messages" role="log" aria-label="Переписка с агентом">${(
    project.chat || []
  )
    .map(
      (m) =>
        `<article class="agent-message ${m.role === "user" ? "from-user" : "from-agent"}"><b>${m.role === "user" ? "Вы" : m.error ? "Агент · запрос не завершён" : "Агент"}</b><div class="message-text">${esc(m.text)}</div>${m.changed ? '<small class="agent-applied">✓ Правки применены</small>' : ""}${(m.files || []).length ? `<div class="hint">${m.files.map((f) => esc(f.name)).join(", ")}</div>` : ""}${
          (m.sources || []).length
            ? `<details><summary>Источники (${m.sources.length})</summary>${m.sources
                .map((s) => {
                  const url = safeWebLink(s.url);
                  return url
                    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || url)}</a><small>${s.kind === "page" ? "Страница прочитана" : "Поисковый фрагмент"}</small>`
                    : "";
                })
                .join("")}</details>`
            : ""
        }</article>`,
    )
    .join(
      "",
    )}<div id="agent-status" role="status" aria-live="polite" hidden></div></div><div class="agent-composer-wrap"><div class="agent-files">${draft.files.map((f, i) => `<span>${esc(f.name)} <button class="tiny subtle" data-remove-chat-file="${i}" aria-label="Убрать ${esc(f.name)}">×</button></span>`).join("")}</div><div id="agent-upload-status" role="status">${chatUploading ? "Читаю файлы…" : ""}</div><div class="agent-composer"><label class="composer-attach" title="Прикрепить файлы">＋<input id="agent-files" type="file" aria-label="Прикрепить файлы" accept=".pdf,.docx,.txt,.md" multiple ${chatUploading ? "disabled" : ""}></label><textarea id="agent-message" aria-label="Сообщение агенту" rows="1" maxlength="12000" placeholder="Что изменить?">${esc(draft.message)}</textarea><details class="agent-menu"><summary aria-label="Настройки агента" title="Настройки агента">⋯</summary><div class="agent-menu-content"><label class="check"><input id="agent-internet" type="checkbox" ${draft.internet ? "checked" : ""}>Поиск в интернете</label><button class="subtle" data-action="undo-agent" ${project.agent_undo?.before ? "" : "disabled"}>↶ Отменить правки</button><div class="agent-menu-info"><span>Модель: ${esc(model)}</span><span>Раздел: ${esc(currentSection()?.title || "не выбран")}</span><span>Enter — отправить · Shift+Enter — новая строка</span></div></div></details><button id="agent-send" class="composer-send" data-action="send-agent" aria-label="Отправить сообщение" title="Отправить сообщение" ${chatUploading ? "disabled" : ""}>↑</button></div></div></details>`;
}
function sizeAgentInput() {
  const input = $("#agent-message");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
}
document.addEventListener("keydown", (e) => {
  if (
    e.target.id === "agent-message" &&
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.isComposing
  ) {
    e.preventDefault();
    guarded(sendAgent)();
  }
  if (e.key === "Escape")
    $$(".agent-menu[open]").forEach((m) => (m.open = false));
});
document.addEventListener("click", (e) => {
  $$(".agent-menu[open]").forEach((m) => {
    if (!m.contains(e.target)) m.open = false;
  });
});

document.addEventListener(
  "toggle",
  (e) => {
    if (project && e.target.classList?.contains("agent-panel")) {
      chatDraft().open = e.target.open;
      if (e.target.open) sizeAgentInput();
    }
  },
  true,
);
function renderAgentStatus() {
  const host = $("#agent-status");
  if (!host) return;
  const agentJob = job?.mode === "agent" ? job : null;
  const busy =
    pendingAgent ||
    (agentJob && ["running", "cancelling"].includes(agentJob.status));
  const error = chatDraft().statusError;
  host.hidden =
    !pendingAgent &&
    !error &&
    (!agentJob || ["complete", "cancelled"].includes(agentJob.status));
  const messages = $(".agent-messages"),
    atBottom =
      messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  host.className =
    "agent-progress " +
    (error || agentJob?.status === "failed" ? "agent-failed" : "");
  host.innerHTML = `${busy ? '<span class="spinner"></span>' : ""}<span>${esc(error || (pendingAgent ? "Отправляю…" : agentJob?.message || ""))}</span>`;
  const send = $("#agent-send"),
    running = agentJob && ["running", "cancelling"].includes(agentJob.status);
  if (send) {
    send.dataset.action = running ? "cancel-job" : "send-agent";
    send.textContent = running ? "■" : "↑";
    send.title = running ? "Остановить" : "Отправить сообщение";
    send.setAttribute("aria-label", send.title);
    send.disabled = Boolean(
      pendingAgent ||
        chatUploading ||
        agentJob?.status === "cancelling" ||
        (job &&
          job.mode !== "agent" &&
          ["running", "cancelling"].includes(job.status)),
    );
  }
  if (atBottom) messages.scrollTop = messages.scrollHeight;
}

async function sendAgent() {
  if (chatUploading || pendingGeneration) return;
  const draft = chatDraft();
  draft.statusError = "";
  if (!draft.message.trim()) {
    draft.statusError = "Напишите сообщение агенту";
    renderAgentStatus();
    return;
  }
  await save();
  pendingGeneration = pendingAgent = true;
  renderJob();
  try {
    job = await api(`/api/projects/${project.id}/chat`, {
      method: "POST",
      body: {
        message: draft.message,
        attachments: draft.files,
        internet: draft.internet,
        section_id: sectionId,
      },
    });
    draft.message = "";
    draft.files = [];
    draft.open = true;
    project = await api(`/api/projects/${project.id}`);
    render();
  } catch (e) {
    draft.statusError = e.message;
  } finally {
    pendingGeneration = pendingAgent = false;
    renderJob();
  }
}

const isConclusion = (s) =>
  s.kind === "conclusion" ||
  ["вывод", "выводы", "заключение"].includes(
    s.title.trim().toLowerCase().replace(/[.:]$/, ""),
  );
const visibleSections = () =>
  project.sections.filter(
    (s) => project.formatting.conclusion || !isConclusion(s),
  );
function composition() {
  return `<section class="composition"><div class="composition-options">${check("Титульный лист", "formatting.title_page")}${check("Содержание", "formatting.toc")}${check("Номера страниц", "formatting.page_numbers")}${check("Вывод", "formatting.conclusion")}</div></section>`;
}

const effortChoices = [
  ["", "По умолчанию модели"],
  ["none", "Без рассуждений (none)"],
  ["minimal", "Минимальная"],
  ["low", "Низкая"],
  ["medium", "Средняя"],
  ["high", "Высокая"],
  ["xhigh", "Очень высокая (xhigh)"],
];
const effortOptions = (value, inherit = false) =>
  (inherit
    ? [["inherit", "Из настроек подключения"], ...effortChoices]
    : effortChoices
  )
    .map(
      ([v, label]) =>
        `<option value="${v}" ${v === value ? "selected" : ""}>${label}</option>`,
    )
    .join("");
const modelCache = new Map();
function defaultModel() {
  const p = activeProfile();
  return (
    localStorage.getItem("praktika-last-model") ||
    p?.model ||
    p?.models?.[0]?.id ||
    ""
  );
}
function activeProfile() {
  const id = localStorage.getItem("praktika-active-profile");
  return profiles.find((p) => p.id === id) || profiles[0] || null;
}
async function rememberProfile(id) {
  if (id) {
    await api("/api/settings", { method: "PUT", body: { profile_id: id } });
    localStorage.setItem("praktika-active-profile", id);
  }
}
function profileDraft() {
  const p = Object.fromEntries(new FormData($("#profile-form")));
  if ($('#profile-form [name="api_key"]').dataset.savedMask === "true")
    p.api_key = "";
  p.temperature = Number(p.temperature);
  p.max_tokens = Number(p.max_tokens);
  p.send_temperature = p.send_temperature === "true";
  p.allow_no_key = $('#profile-form [name="allow_no_key"]').checked;
  return p;
}
function workModelOptions() {
  const p = activeProfile();
  const pid = p?.id;
  const models = modelCache.get(pid) || p?.models || [];
  const options = [...models];
  if (project.model && !options.some((m) => m.id === project.model))
    options.unshift({ id: project.model, name: project.model });
  const q = ($("#work-model-search")?.value || "").toLowerCase();
  return (
    `<option value="">${project.model ? "Последняя выбранная · " + esc(project.model) : "Выберите модель"}</option>` +
    options
      .filter(
        (m) =>
          project.model === m.id ||
          (m.id + " " + m.name).toLowerCase().includes(q),
      )
      .map(
        (m) =>
          `<option value="${esc(m.id)}" ${project.model === m.id ? "selected" : ""}>${esc(m.name === m.id ? m.id : m.name + " · " + m.id)}</option>`,
      )
      .join("")
  );
}
async function loadWorkModels() {
  const p = activeProfile();
  if (!p) return;
  const status = $("#work-model-status");
  if (status) status.textContent = "Загружаю список моделей с ключом роутера…";
  try {
    const r = await api("/api/models", {
      method: "POST",
      body: { ...p, api_key: "" },
    });
    modelCache.set(p.id, r.models);
    if (project) {
      const select = $('[data-field="model"]');
      if (select) select.innerHTML = workModelOptions();
    }
    if ($("#work-model-status"))
      $("#work-model-status").textContent =
        `Доступно моделей: ${r.models.length}`;
  } catch (e) {
    if ($("#work-model-status"))
      $("#work-model-status").textContent =
        e.message + " Укажите ID модели вручную ниже.";
  }
}
async function connectRouter() {
  const p = profileDraft(),
    saved = profiles.find((x) => x.id === p.id);
  if (!p.api_key.trim() && !saved?.has_key && !p.allow_no_key) {
    $("#profile-result").textContent =
      "Введите API-ключ роутера. Без ключа запрос не отправляется.";
    $('#profile-form [name="api_key"]').focus();
    return;
  }
  const button = $("#connect-router");
  connecting = true;
  button.disabled = true;
  $("#close-models").disabled = true;
  $("#profile-result").textContent =
    "Подключаю роутер и загружаю модели с API-ключом…";
  try {
    const result = await api("/api/routers/connect", {
      method: "POST",
      body: p,
    });
    profiles = await api("/api/profiles");
    modelCache.set(result.profile.id, result.profile.models);
    await rememberProfile(result.profile.id);
    if (project) {
      project.profile_id = result.profile.id;
      setDirty();
    }
    editProfile(result.profile);
    $("#profile-result").textContent = result.message;
    toast(result.message);
  } catch (e) {
    $("#profile-result").textContent = e.message;
    throw e;
  } finally {
    connecting = false;
    button.disabled = false;
    $("#close-models").disabled = false;
  }
}
function toast(message, error = false) {
  $("#toast").textContent = message;
  $("#toast").className = error ? "error" : "";
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => ($("#toast").hidden = true),
    error ? 10000 : 4500,
  );
}
async function api(url, options = {}) {
  if (options.body && !(options.body instanceof FormData)) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const data = JSON.parse(text);
      message =
        typeof data.detail === "string"
          ? data.detail
          : "Проверьте введённые данные и допустимые значения.";
    } catch {}
    throw new Error(message || `Ошибка ${response.status}`);
  }
  return response.json();
}
const guarded =
  (fn) =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      toast(e.message, true);
    }
  };
function setDirty() {
  dirty = true;
  revision++;
  $("#save-status").textContent = "Есть изменения…";
  clearTimeout(timer);
  timer = setTimeout(guarded(save), 900);
}
async function save() {
  const invalid = $("#pane textarea:invalid,#pane input:invalid");
  if (invalid) {
    invalid.reportValidity();
    throw new Error(
      "Исправьте выделенное поле перед сохранением или переходом.",
    );
  }
  clearTimeout(timer);
  if (saving) {
    await saving;
    return save();
  }
  if (project && activeProfile() && project.profile_id !== activeProfile().id) {
    project.profile_id = activeProfile().id;
    dirty = true;
  }
  if (!project || !dirty) return;
  if (job && ["running", "cancelling"].includes(job.status))
    throw new Error(
      "Идёт генерация. Редактирование станет доступно после её завершения.",
    );
  const version = revision,
    snapshot = structuredClone(project);
  $("#save-status").textContent = "Сохраняю…";
  saving = api(`/api/projects/${snapshot.id}`, {
    method: "PUT",
    body: snapshot,
  });
  try {
    await saving;
    if (version === revision) dirty = false;
    $("#save-status").textContent = dirty ? "Есть изменения…" : "Сохранено";
  } catch (e) {
    $("#save-status").textContent = "Не сохранено";
    throw e;
  } finally {
    saving = null;
  }
}
async function listProjects() {
  const list = await api("/api/projects");
  $("#projects").innerHTML = list.length
    ? list
        .map(
          (p) =>
            `<button data-project="${p.id}" class="${project?.id === p.id ? "selected" : ""}">${esc(p.title)}<small>${esc(p.topic || "Тема ещё не задана")}</small></button>`,
        )
        .join("")
    : '<p class="hint">Ваши работы появятся здесь</p>';
}
async function openProject(id) {
  await save();
  project = await api(`/api/projects/${id}`);
  if (activeProfile()) project.profile_id = activeProfile().id;
  dirty = false;
  for (const attachment of project.attachments) {
    if (!attachment.enabled) {
      attachment.enabled = true;
      dirty = true;
    }
  }
  if (!project.model && defaultModel()) {
    project.model = defaultModel();
    dirty = true;
  }
  job = await api(`/api/projects/${id}/job`);
  sectionId = project.sections[0]?.id || "";
  $("#welcome").hidden = true;
  $("#workspace").hidden = false;
  $("#export").disabled = false;
  $("#work-title").textContent = project.title;
  $("#save-status").textContent = "Сохранено";
  await listProjects();
  render();
  if (window.matchMedia("(max-width:760px)").matches) setSidebar(true);
}
async function newProject() {
  await save();
  const p = await api("/api/projects", { method: "POST" });
  if (activeProfile()) {
    p.profile_id = activeProfile().id;
    p.model = defaultModel();
    await api(`/api/projects/${p.id}`, { method: "PUT", body: p });
  }
  tab = "brief";
  await openProject(p.id);
}
const field = (label, name, type = "text", value, extra = "") =>
  `<label>${esc(label)}<input data-field="${name}" type="${type}" value="${esc(value ?? getPath(project, name))}" ${extra}></label>`;
const area = (label, name, rows = 4) =>
  `<label>${esc(label)}<textarea data-field="${name}" rows="${rows}">${esc(getPath(project, name))}</textarea></label>`;
function getPath(obj, path) {
  return path.split(".").reduce((o, k) => o[k], obj);
}
function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}
const check = (label, name) =>
  `<label class="check"><input type="checkbox" data-field="${name}" ${getPath(project, name) ? "checked" : ""}>${esc(label)}</label>`;
const foldState = new Map();
function fold(title, body, key, open = false, meta = "", classes = "") {
  const id = project.id + ":" + key,
    expanded = foldState.has(id) ? foldState.get(id) : open;
  return `<details class="fold ${classes}" data-fold="${esc(key)}" ${expanded ? "open" : ""}><summary>${esc(title)}${meta ? `<span class="summary-meta">${esc(meta)}</span>` : ""}</summary>${body}</details>`;
}
document.addEventListener(
  "toggle",
  (e) => {
    if (project && e.target.dataset?.fold && e.target.isConnected)
      foldState.set(project.id + ":" + e.target.dataset.fold, e.target.open);
  },
  true,
);
function profileSelect() {
  return `<div class="generation-controls"><div class="generation-main"><label class="model-control">Модель<select data-field="model">${workModelOptions()}</select></label><label class="effort-control">Старательность<select data-field="reasoning_effort">${effortOptions(project.reasoning_effort === "inherit" ? "" : project.reasoning_effort)}</select></label></div>${fold("Другие параметры", `<div class="model-extra-fields"><label>Поиск по каталогу<input id="work-model-search" placeholder="Название или ID"></label><label>ID модели вручную<input data-manual-model value="${esc(project.model)}" placeholder="Если модели нет в каталоге"></label></div><div class="model-catalog-actions"><button data-action="load-work-models" class="tiny subtle">↻ Обновить каталог</button><span id="work-model-status" class="hint" role="status"></span></div>`, "model-parameters", false, "", "nested model-extras")}</div>`;
}
function updateGenerationSummary() {
  const label = $(".generation-model");
  if (label) {
    label.textContent = project.model || "Модель не выбрана";
    label.title = label.textContent;
  }
}
function compositionSummary() {
  const f = project.formatting;
  return (
    [
      ["title_page", "Титульник"],
      ["toc", "содержание"],
      ["page_numbers", "номера"],
      ["conclusion", "вывод"],
    ]
      .filter(([k]) => f[k])
      .map(([, label]) => label)
      .join(", ") || "Только текст"
  );
}
function fileRows(roles = false, role = "") {
  return project.attachments
    .filter((a) => !role || a.role === role)
    .map(
      (a) =>
        `<div class="file"><div class="file-info"><details data-fold="file-${a.id}"><summary>${esc(a.name)}</summary><small>${a.text.length.toLocaleString("ru")} символов</small>${
          roles
            ? `<label>Тип материала<select data-attachment-role="${a.id}">${[
                ["assignment", "Практическое задание"],
                ["lecture", "Лекция"],
                ["previous", "Предыдущая работа"],
              ]
                .map(
                  ([value, label]) =>
                    `<option value="${value}" ${a.role === value ? "selected" : ""}>${label}</option>`,
                )
                .join("")}</select></label>`
            : ""
        }<pre>${esc(a.text.slice(0, 5000))}${a.text.length > 5000 ? "\n… Показаны первые 5 000 символов" : ""}</pre></details></div><button class="tiny subtle danger" data-remove-file="${a.id}" aria-label="Удалить ${esc(a.name)}">✕</button></div>`,
    )
    .join("");
}
function connectionCard() {
  return `<section class="card">${profileSelect()}</section>`;
}
function extendedBrief() {
  const chars = project.attachments
    .filter((a) => a.enabled)
    .reduce((n, a) => n + a.text.length, 0);
  return `<div class="mode-bar"><strong>Расширенный режим</strong><button data-action="switch-mode" class="tiny">Обычный режим</button></div><div class="split"><div><section class="card"><h2>Задание</h2>${field("Название работы", "title")}${area("Тема", "topic", 2)}<div class="grid2">${field("Дисциплина", "subject")}${field("Объём, страниц", "pages", "number", undefined, 'min="1" max="100"')}</div>${area("Задание и ожидаемый результат", "assignment", 4)}${fold("Промпт и источники", area("Общий промпт", "instructions", 4) + area("Список источников — по одному на строку", "sources", 3), "extended-instructions")}<div class="actions"><button class="primary" data-action="generate-plan">Составить план →</button><button data-action="to-editor">Редактор</button></div></section></div><aside class="settings-stack">${connectionCard()}${fold("Состав документа", composition(), "composition", false, compositionSummary())}${fold("Материалы", `<label class="upload">＋ Добавить файлы<input type="file" id="attach-files" accept=".pdf,.docx,.txt,.md" multiple></label><div id="upload-status" role="status" aria-live="polite"></div>${fileRows()}<p class="hint">Выбрано: <b id="context-count">${chars.toLocaleString("ru")}</b> символов</p>${field("Лимит контекста файлов", "context_limit", "number", undefined, 'min="1000" max="200000" step="1000"')}`, "extended-materials", true, String(project.attachments.length))}${fold("Управление работой", '<button class="danger subtle" data-action="delete-project">Удалить работу</button>', "work-options")}</aside></div>`;
}
function practicalBrief() {
  const assignments = project.attachments.filter(
    (a) => a.enabled && a.role === "assignment",
  );
  const optional = project.attachments.filter(
    (a) => a.role !== "assignment",
  ).length;
  return `<div class="mode-bar"><strong>Практическая работа</strong><button data-action="switch-mode" class="tiny subtle">Расширенный режим ↗</button></div><div class="practical-layout"><div><section class="card"><div class="card-top"><h2>Задание</h2><span class="hint">PDF, DOCX, TXT, MD</span></div><label class="upload">＋ Файл практического задания <small>Обязательно</small><input type="file" data-upload-role="assignment" accept=".pdf,.docx,.txt,.md"></label>${fileRows(true, "assignment")}<p class="assignment-state ">${assignments.length ? "Задание добавлено" : "Добавьте файл, чтобы начать генерацию."}</p>${fold("Лекции и предыдущие работы", `<div class="upload-grid"><div class="material-group"><label class="upload">＋ Лекции<input type="file" data-upload-role="lecture" accept=".pdf,.docx,.txt,.md" multiple></label>${fileRows(true, "lecture")}</div><div class="material-group"><label class="upload">＋ Предыдущие работы<input type="file" data-upload-role="previous" accept=".pdf,.docx,.txt,.md" multiple></label>${fileRows(true, "previous")}</div></div>`, "optional-files", false, optional ? "Файлов: " + optional : "Необязательно", "nested")}<div id="upload-status" role="status" aria-live="polite"></div><label>Промпт<textarea data-field="instructions" rows="4">${esc(project.instructions)}</textarea></label><div class="actions"><button class="primary" data-action="generate-plan">Составить план →</button>${project.sections.length ? '<button data-action="to-editor">К редактору</button>' : ""}</div></section></div><aside class="settings-stack">${connectionCard()}${fold("Состав документа", composition(), "composition", false, compositionSummary())}${fold("Управление работой", field("Название", "title") + '<button class="danger subtle" data-action="delete-project">Удалить работу</button>', "work-options")}</aside></div>`;
}
function brief() {
  return project.work_mode === "extended" ? extendedBrief() : practicalBrief();
}

function newSection() {
  return {
    id: uid(),
    title: "Новый раздел",
    description: "",
    prompt: "",
    new_page: false,
    blocks: [],
  };
}
function currentSection() {
  return project.sections.find((s) => s.id === sectionId);
}
const blockNames = {
  paragraph: "Абзац",
  list: "Маркированный список",
  number_list: "Нумерованный список",
  table: "Таблица",
  page_break: "Разрыв страницы",
};
function editor() {
  let section = currentSection();
  if (!section && project.sections.length) {
    section = project.sections[0];
    sectionId = section.id;
  }
  return `<details class="card generation-settings" data-fold="editor-generation"><summary><span class="generation-title">Параметры генерации</span><span class="generation-model" title="${esc(project.model || "Модель не выбрана")}">${esc(project.model || "Модель не выбрана")}</span></summary>${profileSelect()}</details><div class="section-layout"><aside class="outline"><div class="card"><div class="eyebrow" style="margin-bottom:15px">СТРУКТУРА РАБОТЫ</div>${project.sections.map((s, i) => `<button data-section="${s.id}" class="${s.id === sectionId ? "active" : ""}">${i + 1}. ${esc(s.title)}</button>`).join("")}<button data-action="add-section" class="subtle">＋ Добавить раздел</button><hr style="border:0;border-top:1px solid var(--line)"><button class="primary" data-action="generate-full">Сгенерировать работу</button><details class="fold nested"><summary>Ещё</summary><button data-action="generate-plan">Создать новый план</button></details><p class="hint">Новая генерация заменяет текст выбранных разделов. Готовые разделы сохраняются сразу.</p></div></aside><div>${
    section
      ? `<section class="card"><div class="editor-title-row"><input aria-label="Заголовок раздела" data-section-field="title" value="${esc(section.title)}"><div class="actions"><button class="tiny" data-action="section-up" aria-label="Раздел выше">↑</button><button class="tiny" data-action="section-down" aria-label="Раздел ниже">↓</button><button class="tiny danger" data-action="delete-section">Удалить</button></div></div><details class="fold nested section-options" data-fold="section-options"><summary>Параметры раздела</summary><label>Что должно быть в разделе<textarea data-section-field="description">${esc(section.description)}</textarea></label><label>Дополнительный промпт<textarea data-section-field="prompt" placeholder="Например: добавь таблицу сравнения и пошаговый алгоритм">${esc(section.prompt)}</textarea></label><label class="check"><input type="checkbox" data-section-field="new_page" ${section.new_page ? "checked" : ""}>Начать раздел с новой страницы</label></details><button class="primary" data-action="generate-section">✧ Сгенерировать этот раздел</button></section><section class="card"><div class="card-top"><h3>Содержание</h3><span class="hint">${section.blocks.length} блоков</span></div>${section.blocks.map((b, i) => `<div class="block"><div class="block-head"><span>${String(i + 1).padStart(2, "0")} · ${blockNames[b.type]}</span><div class="actions"><button class="tiny" data-move-block="${b.id}" data-direction="-1" aria-label="Блок выше">↑</button><button class="tiny" data-move-block="${b.id}" data-direction="1" aria-label="Блок ниже">↓</button><button class="tiny danger" data-delete-block="${b.id}" aria-label="Удалить блок">✕</button></div></div>${b.type === "paragraph" ? `<textarea data-block="${b.id}" data-property="text" rows="5">${esc(b.text)}</textarea>` : b.type === "page_break" ? '<div class="manual-break">Начало новой страницы</div>' : b.type === "table" ? `<input aria-label="Название таблицы" data-block="${b.id}" data-property="caption" value="${esc(b.caption)}" placeholder="Название таблицы"><label>Заголовки и строки (ячейки разделяйте символом |)<textarea data-block="${b.id}" data-property="table" rows="6">${esc([b.headers, ...b.rows].map((r) => r.join(" | ")).join("\n"))}</textarea></label><p class="hint">Первая строка — заголовки. В каждой строке должно быть одинаковое число ячеек. Символ | внутри ячейки не поддерживается.</p>` : `<textarea data-block="${b.id}" data-property="items" rows="5" placeholder="Каждый пункт — с новой строки">${esc(b.items.join("\n"))}</textarea>`}</div>`).join("") || '<div class="empty">Добавьте блоки вручную или сгенерируйте раздел</div>'}<details class="fold nested block-add"><summary>＋ Добавить блок</summary><div class="actions">${Object.entries(
          blockNames,
        )
          .map(
            ([type, name]) =>
              `<button class="tiny" data-add-block="${type}">＋ ${name}</button>`,
          )
          .join("")}</div></details></section>`
      : '<section class="card empty"><h2>Начните со структуры</h2><p>Добавьте первый раздел или поручите модели составить план.</p><button class="primary" data-action="add-section">＋ Добавить раздел</button></section>'
  }</div></div>`;
}
function formatting() {
  const f = project.formatting;
  return `<div class="split"><div><section class="card"><div class="card-top"><h2>Оформление</h2><span class="tag">A4</span></div>${composition()}<p class="hint">Настройки применяются к предпросмотру и Word.</p></section>${fold("Шрифт и абзац", `<div class="grid2"><label>Шрифт<select data-field="formatting.font">${["Times New Roman", "Arial"].map((name) => `<option ${f.font === name ? "selected" : ""}>${name}</option>`).join("")}</select></label>${field("Размер, пт", "formatting.size", "number", undefined, 'min="10" max="18"')}${field("Межстрочный интервал", "formatting.spacing", "number", undefined, 'min="1" max="2" step="0.05"')}${field("Отступ первой строки, мм", "formatting.indent", "number", undefined, 'min="0" max="20" step="0.5"')}</div>`, "font-settings", false, `${f.font} · ${f.size} пт · ${f.spacing}`)}${fold("Поля и нумерация", `<div class="grid2">${["left", "right", "top", "bottom"].map((side, i) => field(["Слева, мм", "Справа, мм", "Сверху, мм", "Снизу, мм"][i], "formatting." + side, "number", undefined, 'min="10" max="40"')).join("")}</div>${field("Начать нумерацию с", "formatting.page_start", "number", undefined, 'min="1" max="999"')}`, "page-settings", false, `${f.left} / ${f.right} / ${f.top} / ${f.bottom} мм`)}<div class="actions"><button data-action="preview" class="primary">Предпросмотр →</button></div></div><aside class="title-settings">${fold("Титульный лист", `${field("Образовательная организация", "institution")}${field("Студент", "student")}${field("Группа", "group")}${field("Преподаватель", "teacher")}<div class="grid2">${field("Город", "city")}${field("Год", "year")}</div>`, "title-settings", f.title_page, f.title_page ? "Включён" : "Выключен")}${fold("Оформление в Word", '<p class="hint">Обновите содержание и поля после открытия: Ctrl+A → F9. Титульный лист учитывается в нумерации, но номер на нём скрыт.</p><p class="hint">Переносы в браузере могут отличаться от Word. Сверьте оформление с методичкой учебного заведения.</p>', "word-help")}</aside></div>`;
}

function render() {
  if (!project) return;
  $$(".tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab),
  );
  $("#pane").innerHTML =
    tab === "brief"
      ? brief()
      : tab === "editor"
        ? editor()
        : tab === "format"
          ? formatting()
          : '<div class="preview-tools"><div><h2>Предпросмотр страниц</h2><span class="hint">Приблизительная вёрстка браузера. Итоговые переносы и содержание проверяйте в Word.</span></div><button data-action="print">Печать / PDF</button></div><div class="preview-wrap" id="pages"></div>';
  if (tab === "editor") {
    const settings = $(".generation-settings");
    settings.insertAdjacentHTML("afterend", agentPanel());
    const tools = document.createElement("div");
    tools.className = "editor-tools";
    settings.before(tools);
    tools.append(settings, $(".agent-panel"));
    const messages = $(".agent-messages");
    messages.scrollTop = messages.scrollHeight;
  }
  $$("[data-fold]").forEach((el) => {
    const key = project.id + ":" + el.dataset.fold;
    if (foldState.has(key)) el.open = foldState.get(key);
  });
  if (tab === "preview") buildPreview();
  if (
    ["brief", "editor"].includes(tab) &&
    project.profile_id &&
    !modelCache.has(project.profile_id)
  ) {
    const p = profiles.find((x) => x.id === project.profile_id);
    if (p?.models?.length) modelCache.set(p.id, p.models);
    else loadWorkModels();
  }
  sizeAgentInput();
  renderJob();
}
function renderJob() {
  const busy =
    pendingGeneration ||
    (job && ["running", "cancelling"].includes(job.status));
  $("#job").hidden =
    !job ||
    !["running", "cancelling"].includes(job.status) ||
    job.mode === "agent" ||
    pendingAgent;
  if (job) {
    const labels = {
      running: "В процессе",
      cancelling: "Останавливается",
      complete: "Готово",
      failed: "Ошибка",
      cancelled: "Остановлено",
    };
    $("#job").className = "job-" + job.status;
    $("#job").innerHTML =
      `<div class="job-copy"><strong>${busy ? '<span class="spinner"></span>' : ""}${labels[job.status] || ""}</strong><span>${esc(job.message)}</span><small>Завершено: ${job.done} из ${job.total}${busy ? " · текущий запрос может занимать несколько минут" : ""}</small></div><div class="actions"><progress value="${job.done}" max="${job.total}"></progress>${busy ? `<button class="tiny" data-action="cancel-job" ${job.status === "cancelling" ? "disabled" : ""}>Остановить</button>` : `${job.status === "complete" ? `<button data-action="${["plan", "agent"].includes(job.mode) ? "to-editor" : "to-format"}">${job.mode === "agent" ? "Посмотреть правки →" : job.mode === "plan" ? "Открыть план →" : "Проверить оформление →"}</button>` : ""}<button class="tiny" data-action="dismiss-job" aria-label="Скрыть результат">✕</button>`}</div>`;
  }
  $$("#pane input,#pane textarea,#pane select,#pane button").forEach((el) => {
    if (!el.hasAttribute("data-idle-disabled"))
      el.dataset.idleDisabled = String(el.disabled);
    el.disabled = Boolean(busy) || el.dataset.idleDisabled === "true";
  });
  renderAgentStatus();
  $("#export").disabled = Boolean(busy);
}
function buildPreview() {
  const f = project.formatting,
    host = $("#pages");
  let sheet,
    content,
    tableCount = 0,
    pageIndex = 0;
  const mm = 96 / 25.4,
    available = (297 - f.top - f.bottom) * mm;
  function page() {
    sheet = document.createElement("article");
    sheet.className = "sheet";
    sheet.style.cssText = `padding:${f.top}mm ${f.right}mm ${f.bottom}mm ${f.left}mm;--font:"${f.font}";--font-size:${f.size}pt;--indent:${f.indent}mm;font:${f.size}pt/${f.spacing} "${f.font}";`;
    content = document.createElement("div");
    content.className = "sheet-content";
    sheet.append(content);
    const num = document.createElement("div");
    num.className = "page-number";
    num.textContent = f.page_numbers ? String(f.page_start + pageIndex) : "";
    pageIndex++;
    sheet.append(num);
    host.append(sheet);
  }
  function fits() {
    return content.getBoundingClientRect().height <= available;
  }
  function append(node) {
    content.append(node);
    if (fits()) return;
    node.remove();
    if (
      node.tagName === "P" &&
      node.textContent.trim().split(/\s+/).length > 10
    ) {
      let words = node.textContent.split(/\s+/);
      while (words.length) {
        const part = node.cloneNode(false);
        content.append(part);
        let lo = 0,
          hi = words.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          part.textContent = words.slice(0, mid).join(" ");
          if (fits()) lo = mid;
          else hi = mid - 1;
        }
        if (lo === 0) {
          part.remove();
          page();
          continue;
        }
        part.textContent = words.splice(0, lo).join(" ");
        if (words.length) page();
      }
    } else if (node.tagName === "TABLE") {
      const rows = [...node.tBodies[0].rows].slice(1),
        head = node.rows[0].cloneNode(true);
      let table = document.createElement("table"),
        body = document.createElement("tbody");
      table.append(body);
      body.append(head.cloneNode(true));
      content.append(table);
      for (const row of rows) {
        body.append(row);
        if (!fits() && body.rows.length > 2) {
          row.remove();
          page();
          table = document.createElement("table");
          body = document.createElement("tbody");
          table.append(body);
          body.append(head.cloneNode(true), row);
          content.append(table);
        } else if (!fits() && content.children.length > 1) {
          table.remove();
          page();
          content.append(table);
        }
      }
    } else {
      if (content.children.length) page();
      content.append(node);
    }
  }
  function htmlNode(html) {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    return holder.firstElementChild;
  }
  page();
  if (f.title_page) {
    content.innerHTML = `<div class="title-preview"><p>${esc(project.institution || "Образовательная организация")}</p><div class="title-space"></div><h2>ПРАКТИЧЕСКАЯ РАБОТА</h2><p>${esc(project.topic || project.title)}</p><p>${esc(project.subject ? "Дисциплина: " + project.subject : "")}</p><div class="title-space"></div>${[
      ["Выполнил(а)", project.student],
      ["Группа", project.group],
      ["Проверил(а)", project.teacher],
    ]
      .filter((x) => x[1])
      .map((x) => `<p class="student">${x[0]}: ${esc(x[1])}</p>`)
      .join(
        "",
      )}<div class="title-space"></div><p>${esc(project.city)} ${esc(project.year)}</p></div>`;
    $(".page-number", sheet).textContent = "";
    page();
  }
  if (f.toc) {
    append(htmlNode("<h2>Содержание</h2>"));
    visibleSections().forEach((s) =>
      append(htmlNode(`<p>${esc(s.title)}</p>`)),
    );
    append(
      htmlNode(
        '<p style="font:11px Segoe UI;text-indent:0;margin-top:20px">Номера страниц содержания заполняются в Word после обновления полей.</p>',
      ),
    );
    page();
  }
  visibleSections().forEach((s, i) => {
    if (s.new_page && i && content.children.length) page();
    if (content.getBoundingClientRect().height > available - 100) page();
    append(htmlNode(`<h2>${esc(s.title)}</h2>`));
    s.blocks.forEach((b) => {
      if (b.type === "page_break") page();
      else if (b.type === "paragraph")
        append(htmlNode(`<p>${esc(b.text)}</p>`));
      else if (b.type === "table") {
        append(
          htmlNode(
            `<p class="caption">Таблица ${++tableCount} — ${esc(b.caption || "Данные")}</p>`,
          ),
        );
        append(
          htmlNode(
            `<table><tbody><tr>${b.headers.map((x) => `<th>${esc(x)}</th>`).join("")}</tr>${b.rows.map((r) => `<tr>${r.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
          ),
        );
      } else {
        const tag = b.type === "number_list" ? "ol" : "ul";
        b.items.forEach((x, i) =>
          append(
            htmlNode(
              `<${tag} ${tag === "ol" ? `start="${i + 1}"` : ""}><li>${esc(x)}</li></${tag}>`,
            ),
          ),
        );
      }
    });
  });
  if (project.sources.trim()) {
    append(htmlNode("<h2>Список использованных источников</h2>"));
    project.sources
      .split("\n")
      .filter((x) => x.trim())
      .forEach((x, i) => append(htmlNode(`<p>${i + 1}. ${esc(x)}</p>`)));
  }
}
async function generate(mode) {
  await save();
  if (
    mode === "plan" &&
    project.sections.length &&
    !confirm("Новый план заменит текущую структуру и её текст. Продолжить?")
  )
    return;
  if (
    mode === "full" &&
    project.sections.some((s) => s.blocks.length) &&
    !confirm("Заменить текст всех разделов новой генерацией?")
  )
    return;
  if (
    mode === "section" &&
    currentSection()?.blocks.length &&
    !confirm("Заменить содержание этого раздела?")
  )
    return;
  if (pendingGeneration) return;
  pendingGeneration = true;
  const controls = $$("#pane button");
  controls.forEach((b) => (b.disabled = true));
  $("#save-status").textContent = "Запускаю генерацию…";
  try {
    job = await api(`/api/projects/${project.id}/generate`, {
      method: "POST",
      body: { mode, section_id: sectionId },
    });
    render();
    $("#job").scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    pendingGeneration = false;
    renderJob();
    $("#save-status").textContent = "Сохранено";
  }
}
function move(list, id, direction) {
  const i = list.findIndex((x) => x.id === id),
    j = i + direction;
  if (i >= 0 && j >= 0 && j < list.length)
    [list[i], list[j]] = [list[j], list[i]];
}
const actions = {
  "send-agent": sendAgent,
  "undo-agent": async () => {
    await save();
    project = await api(`/api/projects/${project.id}/chat/undo`, {
      method: "POST",
    });
    render();
    toast("Последние правки агента отменены");
  },
  "switch-mode": () => {
    project.work_mode =
      project.work_mode === "extended" ? "practical" : "extended";
    setDirty();
    render();
  },
  "load-work-models": loadWorkModels,
  "to-format": () => {
    tab = "format";
    render();
  },
  models: openModels,
  "to-editor": () => {
    tab = "editor";
    render();
  },
  preview: () => {
    tab = "preview";
    render();
  },
  print: () => window.print(),
  "add-section": () => {
    const s = newSection();
    project.sections.push(s);
    sectionId = s.id;
    setDirty();
    render();
  },
  "section-up": () => {
    move(project.sections, sectionId, -1);
    setDirty();
    render();
  },
  "section-down": () => {
    move(project.sections, sectionId, 1);
    setDirty();
    render();
  },
  "delete-section": () => {
    if (confirm("Удалить раздел вместе с текстом?")) {
      project.sections = project.sections.filter((s) => s.id !== sectionId);
      setDirty();
      render();
    }
  },
  "generate-plan": () => generate("plan"),
  "generate-full": () => generate("full"),
  "generate-section": () => generate("section"),
  "cancel-job": async () => {
    job = await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    renderJob();
  },
  "dismiss-job": () => {
    job = null;
    renderJob();
  },
  "delete-project": async () => {
    if (!confirm("Удалить работу? Это действие нельзя отменить.")) return;
    await save();
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
    project = null;
    dirty = false;
    job = null;
    $("#workspace").hidden = true;
    $("#welcome").hidden = false;
    $("#export").disabled = true;
    $("#work-title").textContent = "Начните с новой работы";
    await listProjects();
  },
};
document.addEventListener(
  "click",
  guarded(async (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    const invalid = $("#pane textarea:invalid,#pane input:invalid");
    if (invalid && b.closest("#workspace")) {
      invalid.reportValidity();
      throw new Error("Исправьте выделенное поле перед переходом.");
    }
    if (b.dataset.action) {
      await actions[b.dataset.action]?.();
      return;
    }
    if (b.dataset.project) {
      await openProject(b.dataset.project);
      return;
    }
    if (b.dataset.tab) {
      await save();
      tab = b.dataset.tab;
      render();
      return;
    }
    if (b.dataset.section) {
      sectionId = b.dataset.section;
      render();
      return;
    }
    if (b.dataset.addBlock) {
      const type = b.dataset.addBlock;
      currentSection().blocks.push({
        id: uid(),
        type,
        text: "",
        items: [],
        caption: "",
        headers: type === "table" ? ["Параметр", "Значение"] : [],
        rows: type === "table" ? [["", ""]] : [],
      });
      setDirty();
      render();
      return;
    }
    if (b.dataset.deleteBlock) {
      currentSection().blocks = currentSection().blocks.filter(
        (x) => x.id !== b.dataset.deleteBlock,
      );
      setDirty();
      render();
      return;
    }
    if (b.dataset.moveBlock) {
      move(
        currentSection().blocks,
        b.dataset.moveBlock,
        Number(b.dataset.direction),
      );
      setDirty();
      render();
      return;
    }
    if (b.dataset.removeChatFile !== undefined) {
      chatDraft().files.splice(Number(b.dataset.removeChatFile), 1);
      render();
      return;
    }
    if (b.dataset.removeFile) {
      project.attachments = project.attachments.filter(
        (a) => a.id !== b.dataset.removeFile,
      );
      setDirty();
      render();
      return;
    }
  }),
);
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!project) return;
  if (el.id === "agent-message") {
    chatDraft().message = el.value;
    sizeAgentInput();
    return;
  }
  if (el.id === "agent-internet") {
    chatDraft().internet = el.checked;
    return;
  }
  if (el.id === "work-model-search") {
    $('[data-field="model"]').innerHTML = workModelOptions();
    return;
  }
  if (el.hasAttribute("data-manual-model")) {
    project.model = el.value.trim();
    if (project.model)
      localStorage.setItem("praktika-last-model", project.model);
    updateGenerationSummary();
    $('[data-field="model"]').innerHTML = workModelOptions();
    setDirty();
    return;
  }
  if (el.dataset.field) {
    if (el.type === "number" && !el.validity.valid) {
      $("#save-status").textContent = "Проверьте число";
      return;
    }
    setPath(
      project,
      el.dataset.field,
      el.type === "checkbox"
        ? el.checked
        : el.type === "number"
          ? Number(el.value)
          : el.value,
    );
    if (el.dataset.field === "title") $("#work-title").textContent = el.value;
    if (el.dataset.field.startsWith("formatting.") && el.type === "checkbox") {
      setDirty();
      render();
      return;
    }
    if (el.dataset.field === "model") {
      updateGenerationSummary();
      if (el.value) localStorage.setItem("praktika-last-model", el.value);
      const manual = $("[data-manual-model]");
      if (manual) manual.value = el.value;
    }
    setDirty();
  }
  if (el.dataset.sectionField) {
    currentSection()[el.dataset.sectionField] =
      el.type === "checkbox" ? el.checked : el.value;
    setDirty();
  }
  if (el.dataset.block && el.dataset.property !== "table") {
    const b = currentSection().blocks.find((x) => x.id === el.dataset.block);
    b[el.dataset.property] =
      el.dataset.property === "items" ? el.value.split("\n") : el.value;
    setDirty();
  }
  if (el.dataset.property === "table") {
    const rows = el.value
      .split("\n")
      .filter((x) => x.trim())
      .map((r) => r.split("|").map((x) => x.trim()));
    const valid =
      rows.length &&
      rows[0].length <= 12 &&
      rows.length <= 501 &&
      rows.every((r) => r.length === rows[0].length);
    el.setCustomValidity(
      valid
        ? ""
        : "В каждой строке должно быть одинаковое число ячеек, не более 12 столбцов и 500 строк",
    );
    if (valid) {
      const b = currentSection().blocks.find((x) => x.id === el.dataset.block);
      b.headers = rows[0];
      b.rows = rows.slice(1);
      setDirty();
    }
  }
  if (el.dataset.attachmentRole) {
    project.attachments.find((a) => a.id === el.dataset.attachmentRole).role =
      el.value;
    setDirty();
    render();
  }
});
document.addEventListener(
  "change",
  guarded(async (e) => {
    const el = e.target;
    if (el.id === "agent-files") {
      const id = project.id,
        draft = chatDraft(),
        files = [...el.files];
      if (draft.files.length + files.length > 10)
        throw new Error("К сообщению можно прикрепить до 10 файлов");
      chatUploading = true;
      el.disabled = true;
      try {
        for (const file of files) {
          const status = $("#agent-upload-status");
          if (status) status.textContent = "Читаю " + file.name + "…";
          const form = new FormData();
          form.append("file", file);
          const extracted = await api("/api/extract", {
            method: "POST",
            body: form,
          });
          draft.files.push(extracted);
        }
      } finally {
        chatUploading = false;
        if (project?.id === id) render();
      }
      return;
    }
    if (el.dataset.property === "table") {
      const rows = el.value
        .split("\n")
        .filter((x) => x.trim())
        .map((r) => r.split("|").map((x) => x.trim()));
      if (!rows.length || rows.some((r) => r.length !== rows[0].length)) {
        el.setCustomValidity(
          "В каждой строке должно быть одинаковое число ячеек",
        );
        el.reportValidity();
        throw new Error(
          "Таблица не сохранена: выровняйте число ячеек в строках.",
        );
      }
      el.setCustomValidity("");
      const b = currentSection().blocks.find((x) => x.id === el.dataset.block);
      b.headers = rows[0];
      b.rows = rows.slice(1);
      setDirty();
    }
    if (el.id === "attach-files" || el.dataset.uploadRole) {
      await save();
      el.disabled = true;
      try {
        let fileIndex = 0;
        for (const file of el.files) {
          $("#upload-status").innerHTML =
            `<span class="spinner"></span> Читаю файл ${++fileIndex} из ${el.files.length}: ${esc(file.name)}`;
          const form = new FormData();
          form.append("file", file);
          const a = await api("/api/extract", { method: "POST", body: form });
          a.role = el.dataset.uploadRole || "assignment";
          project.attachments.push(a);
          if (project.work_mode === "practical" && !project.topic) {
            project.topic = a.name.replace(/\.[^.]+$/, "");
            project.title = project.topic;
            $("#work-title").textContent = project.title;
          }
          setDirty();
        }
        await save();
        render();
        toast("Материалы добавлены. Теперь можно составить план.");
      } catch (e) {
        if ($("#upload-status"))
          $("#upload-status").textContent = "Ошибка загрузки: " + e.message;
        throw e;
      } finally {
        el.disabled = false;
      }
    }
  }),
);
async function openModels() {
  await save();
  profiles = await api("/api/profiles");
  $("#model-dialog").showModal();
  editProfile(activeProfile());
}
function editProfile(profile) {
  profileId = profile?.id || uid();
  const p = profile || {
    id: profileId,
    name: "Новый роутер",
    base_url: "https://routerai.ru/api/v1",
    model: "",
    mode: "json",
    temperature: 0.7,
    max_tokens: 4096,
    token_parameter: "max_tokens",
    send_temperature: false,
    reasoning_effort: "",
    allow_no_key: false,
  };
  for (const [key, value] of Object.entries(p)) {
    const input = $(`[name="${key}"]`, $("#profile-form"));
    if (input) {
      if (input.type === "checkbox") input.checked = value;
      else input.value = value;
    }
  }
  const keyInput = $('#profile-form [name="api_key"]');
  keyInput.type = "password";
  keyInput.value = profile?.has_key ? "••••••••••••••••" : "";
  keyInput.dataset.savedMask = profile?.has_key ? "true" : "false";
  $("#toggle-key").setAttribute("aria-pressed", "false");
  $("#toggle-key").setAttribute("aria-label", "Показать API-ключ");
  $("#toggle-key").textContent = "👁";
  $('#profile-form [name="api_key"]').placeholder = profile?.has_key
    ? "Ключ сохранён — оставьте пустым, чтобы использовать его"
    : "Введите API-ключ роутера";
  $("#profile-result").textContent = profile?.has_key
    ? "Ключ сохранён. При подключении и загрузке моделей используется этот ключ."
    : "Введите адрес и API-ключ, затем нажмите «Подключить роутер».";
  $("#profile-list").innerHTML = profiles
    .map(
      (p) =>
        `<button data-profile="${p.id}" class="${p.id === profileId ? "active" : ""}">${esc(p.name)}${p.id === activeProfile()?.id ? " · используется" : ""}</button>`,
    )
    .join("");
  $("#delete-profile").disabled = !profile;
  $("#router-catalog-info").textContent = profile?.catalog_supported
    ? `Каталог загружен: ${profile.models.length} моделей. Модель выбирается в работе.`
    : "Модель и старательность выбираются в работе перед генерацией.";
}
$("#profile-list").onclick = guarded(async (e) => {
  const b = e.target.closest("[data-profile]");
  if (b) {
    await save();
    await rememberProfile(b.dataset.profile);
    editProfile(profiles.find((p) => p.id === b.dataset.profile));
    if (project) {
      project.profile_id = b.dataset.profile;
      project.model = defaultModel();
      setDirty();
      render();
    }
  }
});
$("#profile-form").onsubmit = guarded(async (e) => {
  e.preventDefault();
  await connectRouter();
});
$("#delete-profile").onclick = guarded(async () => {
  if (!confirm("Удалить подключение и сохранённый ключ?")) return;
  await api(`/api/profiles/${profileId}`, { method: "DELETE" });
  profiles = await api("/api/profiles");
  const prefs = await api("/api/settings");
  localStorage.setItem("praktika-active-profile", prefs.profile_id || "");
  editProfile(activeProfile());
});
$("#add-profile").onclick = () => editProfile(null);
$("#close-models").onclick = () => {
  if (!connecting) $("#model-dialog").close();
};
const routerDialog = $("#model-dialog");
let backdropStart = false;
function outsideDialog(e) {
  const r = routerDialog.getBoundingClientRect();
  return (
    e.clientX < r.left ||
    e.clientX > r.right ||
    e.clientY < r.top ||
    e.clientY > r.bottom
  );
}
routerDialog.addEventListener("pointerdown", (e) => {
  backdropStart = e.target === routerDialog && outsideDialog(e);
});
routerDialog.addEventListener("click", (e) => {
  if (
    backdropStart &&
    e.target === routerDialog &&
    outsideDialog(e) &&
    !connecting
  )
    routerDialog.close();
  backdropStart = false;
});
routerDialog.addEventListener("cancel", (e) => {
  if (connecting) e.preventDefault();
});
routerDialog.addEventListener("close", () => {
  const k = $('#profile-form [name="api_key"]');
  k.value = "";
  k.type = "password";
  if (project) render();
});
const keyInput = $('#profile-form [name="api_key"]');
keyInput.addEventListener("beforeinput", () => {
  if (keyInput.dataset.savedMask === "true") {
    keyInput.value = "";
    keyInput.dataset.savedMask = "false";
  }
});
keyInput.addEventListener("input", () => {
  if (keyInput.value !== "••••••••••••••••")
    keyInput.dataset.savedMask = "false";
});
$("#toggle-key").onclick = guarded(async () => {
  const button = $("#toggle-key");
  if (keyInput.type === "password") {
    button.disabled = true;
    const id = profileId;
    try {
      if (keyInput.dataset.savedMask === "true") {
        const result = await api(`/api/profiles/${id}/reveal-key`, {
          method: "POST",
        });
        if (profileId !== id || !routerDialog.open) return;
        keyInput.value = result.api_key;
        keyInput.dataset.savedMask = "false";
      }
      keyInput.type = "text";
      button.setAttribute("aria-pressed", "true");
      button.setAttribute("aria-label", "Скрыть API-ключ");
      button.textContent = "Скрыть";
    } finally {
      button.disabled = false;
    }
  } else {
    keyInput.type = "password";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", "Показать API-ключ");
    button.textContent = "👁";
  }
});

$("#new-project").onclick = $("#welcome-new").onclick = guarded(newProject);
$("#models").onclick = guarded(openModels);
$("#export").onclick = guarded(async () => {
  await save();
  toast("Word готовится к скачиванию. Проверьте загрузки браузера.");
  window.location.href = `/api/projects/${project.id}/export.docx`;
});
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
let polling = false;
setInterval(async () => {
  if (
    !project ||
    !job ||
    !["running", "cancelling"].includes(job.status) ||
    polling
  )
    return;
  polling = true;
  const id = project.id;
  try {
    const next = await api(`/api/projects/${id}/job`);
    if (project?.id !== id) return;
    job = next;
    if (job && !["running", "cancelling"].includes(job.status)) {
      project = await api(`/api/projects/${id}`);
      const planReady = job.mode === "plan" && job.status === "complete";
      if (planReady) {
        tab = "editor";
        sectionId = project.sections[0]?.id || "";
      }
      render();
      await listProjects();
      if (job.mode !== "agent") {
        toast(job.message, job.status === "failed");
        if (planReady) window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } else renderJob();
  } catch (e) {
    toast(e.message, true);
  } finally {
    polling = false;
  }
}, 1500);
guarded(async () => {
  profiles = await api("/api/profiles");
  const prefs = await api("/api/settings");
  if (prefs.profile_id)
    localStorage.setItem("praktika-active-profile", prefs.profile_id);
  if (prefs.model) localStorage.setItem("praktika-last-model", prefs.model);
  if (!prefs.profile_id && activeProfile())
    await rememberProfile(activeProfile().id);
  await listProjects();
})();

function setSidebar(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  $("#sidebar").inert = collapsed;
  $("#sidebar").setAttribute("aria-hidden", String(collapsed));
  $("#sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
  $("#sidebar-toggle").setAttribute(
    "aria-label",
    collapsed ? "Показать список работ" : "Свернуть список работ",
  );
  try {
    localStorage.setItem("praktika-sidebar", String(collapsed));
  } catch {}
}
let sidebarDefault = window.matchMedia("(max-width:760px)").matches;
try {
  const saved = localStorage.getItem("praktika-sidebar");
  if (saved !== null) sidebarDefault = saved === "true";
} catch {}
setSidebar(sidebarDefault);
$("#sidebar-toggle").onclick = () =>
  setSidebar(!document.body.classList.contains("sidebar-collapsed"));
$("#sidebar-backdrop").onclick = () => setSidebar(true);

window.matchMedia("(max-width:760px)").addEventListener("change", (e) => {
  if (e.matches) setSidebar(true);
});

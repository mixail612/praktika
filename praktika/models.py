from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator


def uid():
    return uuid4().hex


class Block(BaseModel):
    id: str = Field(default_factory=uid)
    type: Literal["paragraph", "list", "number_list", "table", "page_break"] = "paragraph"
    text: str = ""
    items: list[str] = Field(default_factory=list)
    caption: str = ""
    headers: list[str] = Field(default_factory=list, max_length=12)
    rows: list[list[str]] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def valid_table(self):
        if self.type == "table":
            if not self.headers or any(len(r) != len(self.headers) for r in self.rows):
                raise ValueError("В таблице нужны заголовки и одинаковое число ячеек в строках")
        return self


class Section(BaseModel):
    id: str = Field(default_factory=uid)
    title: str = "Новый раздел"
    description: str = ""
    prompt: str = ""
    new_page: bool = False
    blocks: list[Block] = Field(default_factory=list)
    kind: Literal["section", "conclusion"] = "section"


class Formatting(BaseModel):
    font: Literal["Times New Roman", "Arial"] = "Times New Roman"
    size: int = Field(14, ge=10, le=18)
    spacing: float = Field(1.5, ge=1, le=2)
    left: float = Field(30, ge=10, le=40)
    right: float = Field(15, ge=10, le=40)
    top: float = Field(20, ge=10, le=40)
    bottom: float = Field(20, ge=10, le=40)
    indent: float = Field(12.5, ge=0, le=20)
    page_start: int = Field(1, ge=1, le=999)
    title_page: bool = True
    toc: bool = False
    page_numbers: bool = True
    conclusion: bool = True


class Attachment(BaseModel):
    id: str = Field(default_factory=uid)
    name: str
    text: str = Field(max_length=1_000_000)
    enabled: bool = True
    role: Literal["assignment", "lecture", "previous"] = "assignment"


class Project(BaseModel):
    id: str = Field(default_factory=uid)
    title: str = "Новая практическая работа"
    work_mode: Literal["practical", "extended"] = "extended"
    topic: str = ""
    subject: str = ""
    assignment: str = ""
    pages: int = Field(5, ge=1, le=100)
    instructions: str = "Выполняй только то, что требуется в практическом задании. Делай именно задания из файла, не добавляй лишних разделов и не раздувай объём работы. Пиши по существу, не выдумывай факты, результаты и источники."
    institution: str = ""
    student: str = ""
    group: str = ""
    teacher: str = ""
    city: str = ""
    year: str = "2026"
    profile_id: str = ""
    model: str = ""
    reasoning_effort: Literal[
        "inherit", "", "none", "minimal", "low", "medium", "high", "xhigh"
    ] = "inherit"
    context_limit: int = Field(40000, ge=1000, le=200000)
    formatting: Formatting = Field(default_factory=Formatting)
    sections: list[Section] = Field(default_factory=list)
    attachments: list[Attachment] = Field(default_factory=list)
    sources: str = ""
    updated: str = ""
    chat: list[dict] = Field(default_factory=list, max_length=200)
    agent_undo: dict = Field(default_factory=dict)


class Profile(BaseModel):
    id: str = Field(default_factory=uid)
    name: str = "OpenAI"
    base_url: str = "https://api.openai.com/v1"
    model: str = ""
    allow_no_key: bool = False
    models: list[dict[str, str]] = Field(default_factory=list)
    catalog_supported: bool = False
    mode: Literal["json", "text"] = "json"
    temperature: float = Field(0.7, ge=0, le=2)
    max_tokens: int = Field(4096, ge=256, le=64000)
    token_parameter: Literal["max_tokens", "max_completion_tokens"] = "max_tokens"
    send_temperature: bool = False
    reasoning_effort: Literal["", "none", "minimal", "low", "medium", "high", "xhigh"] = ""


class ProfileInput(Profile):
    api_key: str = ""


def is_conclusion(section):
    return section.kind == "conclusion" or section.title.strip().lower().rstrip(".:") in (
        "вывод",
        "выводы",
        "заключение",
    )


def document_sections(project):
    return [s for s in project.sections if project.formatting.conclusion or not is_conclusion(s)]

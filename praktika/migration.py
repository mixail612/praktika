"""Compatibility with documents produced by the original coursework scripts."""

from .models import Block, Project, Section


def project_from_data(data: dict, title: str = "Импорт") -> Project:
    if "sections" in data:
        return Project.model_validate(data)
    sections = []
    for chapter, subsections in data.items():
        for sub in subsections:
            blocks = []
            for value in sub.get("paragraphs", []):
                if isinstance(value, str):
                    blocks.append(Block(text=value))
                    continue
                value = dict(value)
                if value.get("type") == "text":
                    value["type"] = "paragraph"
                    value["text"] = value.pop("content", "")
                blocks.append(Block.model_validate(value))
            sections.append(Section(title=sub.get("subsection_title", chapter), blocks=blocks))
    return Project(title=title, sections=sections)

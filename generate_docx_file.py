"""Compatibility entry point for the previous JSON to DOCX script."""

import json
from pathlib import Path

from praktika.documents import export_docx
from praktika.migration import project_from_data


def generate_word_from_json(json_file_path, output_docx_path):
    data = json.loads(Path(json_file_path).read_text(encoding="utf-8-sig"))
    project = project_from_data(data, Path(json_file_path).stem)
    if "sections" not in data:
        project.formatting.title_page = False
    Path(output_docx_path).write_bytes(export_docx(project))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Convert a legacy or current document to DOCX.")
    parser.add_argument("input", help="Path to the source document")
    parser.add_argument("output", help="Path to the resulting DOCX")
    args = parser.parse_args()
    generate_word_from_json(args.input, args.output)

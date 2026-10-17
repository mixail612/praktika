"""Create a publication archive from an explicit allowlist, never personal files."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = (
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".env.example",
    "pyproject.toml",
    "README.md",
    "LICENSE",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "requirements.txt",
    "requirements-dev.txt",
    "main.py",
    "start.bat",
    "build.bat",
    "Praktika.spec",
    "generate_docx_file.py",
)
PATTERNS = {
    "praktika": ("*.py",),
    "praktika/web": ("*.js", "*.css", "*.html"),
    "tests": ("*.py",),
    "tests/fixtures": ("*.json",),
    "scripts": ("*.py",),
    "docs": ("*.md",),
    ".github/workflows": ("*.yml",),
    ".github/ISSUE_TEMPLATE": ("*.yml",),
    ".github": ("*.md",),
}


def source_files():
    paths = [ROOT / name for name in ROOT_FILES]
    for folder, patterns in PATTERNS.items():
        for pattern in patterns:
            paths.extend((ROOT / folder).glob(pattern))
    for path in sorted(set(paths)):
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Missing file or unsafe symlink: {path.relative_to(ROOT)}")
        yield path


def main():
    target = ROOT / "release" / "Praktika-source.zip"
    target.parent.mkdir(exist_ok=True)
    with ZipFile(target, "w", ZIP_DEFLATED) as archive:
        for path in source_files():
            archive.write(path, path.relative_to(ROOT).as_posix())
    print(f"Created {target}")


if __name__ == "__main__":
    main()

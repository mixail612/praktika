"""Package the complete PyInstaller directory with user-facing documentation."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]


def main():
    app = ROOT / "dist" / "Praktika"
    if not (app / "Praktika.exe").is_file():
        raise SystemExit("Build Praktika.spec on Windows before packaging.")
    target = ROOT / "release" / "Praktika-windows-x64.zip"
    target.parent.mkdir(exist_ok=True)
    with ZipFile(target, "w", ZIP_DEFLATED) as archive:
        for path in sorted(app.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"Unexpected symlink: {path}")
            if path.is_file():
                archive.write(path, (Path("Praktika") / path.relative_to(app)).as_posix())
        for name in ("README.md", "LICENSE"):
            archive.write(ROOT / name, f"Praktika/{name}")
    print(f"Created {target}")


if __name__ == "__main__":
    main()

@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    py -3.11 -m venv .venv
    if errorlevel 1 goto failed
)
".venv\Scripts\python.exe" -m pip install -r requirements-dev.txt
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m ruff check .
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m ruff format --check .
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m unittest discover -s tests -q
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean Praktika.spec
if errorlevel 1 goto failed
".venv\Scripts\python.exe" scripts\package_windows.py
if errorlevel 1 goto failed
echo Ready: release\Praktika-windows-x64.zip
exit /b 0
:failed
echo Build failed. See error above.
exit /b 1

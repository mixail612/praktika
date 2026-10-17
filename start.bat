@echo off
cd /d "%~dp0"
if exist "dist\Praktika\Praktika.exe" (
    start "" "dist\Praktika\Praktika.exe"
    exit /b
)
if not exist ".venv\Scripts\python.exe" (
    py -3.11 -m venv .venv
    if errorlevel 1 goto failed
)
".venv\Scripts\python.exe" -c "import fastapi, uvicorn, docx, openai, pypdf, keyring, multipart" >nul 2>&1
if errorlevel 1 (
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 goto failed
)
".venv\Scripts\python.exe" main.py
if errorlevel 1 goto failed
exit /b
:failed
echo Failed to start Praktika. See error above.
pause
exit /b 1

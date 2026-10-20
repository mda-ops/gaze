@echo off
cd /d "%~dp0"
echo Starting Revenue Analytics...
echo.
echo Open http://127.0.0.1:8766 in your browser.
echo Close this window or press Ctrl+C to stop.
echo.
"C:\Users\HP\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m app.web
pause

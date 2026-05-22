@echo off
chcp 65001 > nul
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    msg "%username%" "Python не найден"
    exit /b 1
)

rem Убить предыдущую копию приложения
taskkill /F /IM pythonw.exe /FI "WINDOWTITLE eq app.py" >nul 2>&1
powershell -Command "Get-Process pythonw,python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'app\\.py' } | Stop-Process -Force" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| find ":7878" ^| find "LISTENING"') do taskkill /F /PID %%a >nul 2>&1

start "" pythonw "%~dp0app.py"
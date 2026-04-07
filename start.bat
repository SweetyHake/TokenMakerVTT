@echo off
chcp 65001 > nul
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo Python не найден. Установите Python 3.9+
    pause
    exit /b 1
)

python -c "import webview" >nul 2>&1
if errorlevel 1 (
    echo Установка pywebview...
    pip install pywebview
)

python -c "import webview; backends = getattr(webview, 'guilib', None)" >nul 2>&1

echo Запуск...
python app.py

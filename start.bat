@echo off
chcp 65001 > nul
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Python не найден. Установите Python 3.11 или 3.12 с python.org
    pause
    exit /b 1
)

for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo Найден Python %PYVER%

echo Проверка и установка зависимостей...

python -c "import pip" >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] pip не найден
    pause
    exit /b 1
)

pip install --upgrade pip --quiet

python -c "import numpy" >nul 2>&1
if errorlevel 1 (
    echo Установка numpy...
    pip install numpy
    if errorlevel 1 ( echo [ОШИБКА] Не удалось установить numpy & pause & exit /b 1 )
)

python -c "import PIL" >nul 2>&1
if errorlevel 1 (
    echo Установка Pillow...
    pip install Pillow
    if errorlevel 1 ( echo [ОШИБКА] Не удалось установить Pillow & pause & exit /b 1 )
)

python -c "import onnxruntime" >nul 2>&1
if errorlevel 1 (
    echo Установка onnxruntime...
    pip install onnxruntime-directml
    if errorlevel 1 (
        echo onnxruntime-directml недоступен, пробуем обычный...
        pip install onnxruntime
        if errorlevel 1 ( echo [ОШИБКА] Не удалось установить onnxruntime & pause & exit /b 1 )
    )
)

python -c "import flask" >nul 2>&1
if errorlevel 1 (
    echo Установка flask...
    pip install flask
    if errorlevel 1 ( echo [ОШИБКА] Не удалось установить flask & pause & exit /b 1 )
)

python -c "import webview" >nul 2>&1
if errorlevel 1 (
    echo Установка pywebview...
    pip install pywebview
    if errorlevel 1 ( echo [ОШИБКА] Не удалось установить pywebview & pause & exit /b 1 )
)

echo.
echo Все зависимости установлены. Запуск...
echo.
python app.py
if errorlevel 1 (
    echo.
    echo [ОШИБКА] Приложение завершилось с ошибкой
    pause
)
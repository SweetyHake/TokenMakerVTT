@echo off
chcp 65001 > nul
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.11 or 3.12 from python.org
    pause
    exit /b 1
)

for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo Python %PYVER% found

echo Checking dependencies...

python -c "import pip" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] pip not found
    pause
    exit /b 1
)

pip install --upgrade pip --quiet

python -c "import numpy" >nul 2>&1
if errorlevel 1 (
    echo Installing numpy...
    pip install numpy
    if errorlevel 1 ( echo [ERROR] Failed to install numpy & pause & exit /b 1 )
)

python -c "import PIL" >nul 2>&1
if errorlevel 1 (
    echo Installing Pillow...
    pip install Pillow
    if errorlevel 1 ( echo [ERROR] Failed to install Pillow & pause & exit /b 1 )
)

python -c "import onnxruntime" >nul 2>&1
if errorlevel 1 (
    echo Installing onnxruntime...
    pip install onnxruntime-directml
    if errorlevel 1 (
        echo onnxruntime-directml not available, trying standard...
        pip install onnxruntime
        if errorlevel 1 ( echo [ERROR] Failed to install onnxruntime & pause & exit /b 1 )
    )
)

python -c "import flask" >nul 2>&1
if errorlevel 1 (
    echo Installing flask...
    pip install flask
    if errorlevel 1 ( echo [ERROR] Failed to install flask & pause & exit /b 1 )
)

python -c "import webview" >nul 2>&1
if errorlevel 1 (
    echo Installing pywebview...
    pip install pywebview
    if errorlevel 1 ( echo [ERROR] Failed to install pywebview & pause & exit /b 1 )
)

python -c "import psutil" >nul 2>&1
if errorlevel 1 (
    echo Installing psutil...
    pip install psutil
    if errorlevel 1 ( echo [ERROR] Failed to install psutil & pause & exit /b 1 )
)

echo.
echo All dependencies installed. Starting...
echo.
python app.py
if errorlevel 1 (
    echo.
    echo [ERROR] Application exited with error
    pause
)
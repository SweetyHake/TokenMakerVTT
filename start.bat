@echo off
chcp 65001 > nul
cd /d "%~dp0"
title Token Maker — Запуск...

where python >nul 2>&1
if errorlevel 1 (
    echo ОШИБКА: Python не найден.
    echo Установите Python с python.org
    goto :error
)

echo [1/4] Остановка предыдущей копии...
taskkill /F /IM pythonw.exe /FI "WINDOWTITLE eq app.py" >nul 2>&1
powershell -Command "Get-Process pythonw,python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'app\\.py' } | Stop-Process -Force" >nul 2>&1

echo [2/4] Освобождение порта 7878...
for /f "tokens=5" %%a in ('netstat -ano ^| find ":7878" ^| find "LISTENING"') do taskkill /F /PID %%a >nul 2>&1

echo [3/4] Проверка зависимостей...
python -c "import onnxruntime" >nul 2>&1
if errorlevel 1 (
    echo   Установка onnxruntime-directml...
    python -m pip install onnxruntime-directml numpy Pillow flask pywebview psutil
    if errorlevel 1 (
        echo   ОШИБКА: Не удалось установить зависимости.
        echo   Попробуйте вручную в командной строке:
        echo   pip install onnxruntime-directml numpy Pillow flask pywebview psutil
        goto :error
    )
)

echo [4/4] Запуск...
start "" pythonw "%~dp0app.py"
if errorlevel 1 (
    echo ОШИБКА: Не удалось запустить приложение
    goto :error
)
echo Token Maker запущен
timeout /t 2 >nul
exit /b 0

:error
echo.
echo =============================================
echo  ПРОИЗОШЛА ОШИБКА — окно не закроется
echo  Скопируйте текст выше и отправьте разработчику
echo =============================================
pause
exit /b 1
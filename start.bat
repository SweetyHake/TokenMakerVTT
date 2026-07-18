@echo off
chcp 65001 > nul
cd /d "%~dp0"
title Token Maker — Запуск...

call :check_python
if errorlevel 1 goto :error

echo [1/4] Остановка предыдущей копии...
call :kill_app
echo [2/4] Освобождение порта 7878...
call :free_port
echo [3/4] Проверка зависимостей...
call :check_deps
if errorlevel 1 goto :error

echo [4/4] Запуск приложения...
start "" pythonw "%~dp0app.py"
if errorlevel 1 (
    echo ОШИБКА: Не удалось запустить приложение
    goto :error
)
echo Token Maker запущен
timeout /t 2 >nul
exit /b 0

:check_python
where python >nul 2>&1
if not errorlevel 1 exit /b 0
echo ОШИБКА: Python не найден. Установите Python с python.org
echo.
echo Путь: %%PATH%%
exit /b 1

:kill_app
taskkill /F /IM pythonw.exe /FI "WINDOWTITLE eq app.py" >nul 2>&1
powershell -Command "Get-Process pythonw,python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'app\\.py' } | Stop-Process -Force" >nul 2>&1
exit /b 0

:free_port
for /f "tokens=5" %%a in ('netstat -ano ^| find ":7878" ^| find "LISTENING"') do (
    echo   - убит процесс с PID %%a
    taskkill /F /PID %%a >nul 2>&1
)
exit /b 0

:check_deps
pip show onnxruntime-directml >nul 2>&1
if errorlevel 1 (
    echo Зависимости не найдены. Установка...
    pip install onnxruntime-directml numpy Pillow flask pywebview psutil
    if errorlevel 1 (
        echo ОШИБКА: Не удалось установить зависимости
        exit /b 1
    )
)
exit /b 0

:error
echo.
echo ============================================
echo  ПРОИЗОШЛА ОШИБКА
echo  Исправьте проблему и запустите start.bat снова
echo ============================================
pause
exit /b 1
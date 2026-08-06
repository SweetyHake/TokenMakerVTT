@echo off
cd /d "%~dp0"

echo ========================================
echo   Token Maker - build .exe
echo ========================================
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found
    pause
    exit /b 1
)

pip install pyinstaller -q >nul 2>&1

echo Building...
python -m PyInstaller build.spec --noconfirm
if errorlevel 1 (
    echo [ERROR] PyInstaller build failed
    pause
    exit /b 1
)

echo Copying extra folders...
xcopy /E /I /Y "token_rings" "dist\TokenMaker\token_rings" > nul
xcopy /E /I /Y "presets" "dist\TokenMaker\presets" > nul

echo Copying icon and images next to exe...
xcopy /Y "icon.ico" "dist\TokenMaker\" > nul
xcopy /Y "mask.png" "dist\TokenMaker\" > nul
xcopy /Y "logo.png" "dist\TokenMaker\" > nul
xcopy /Y "example.png" "dist\TokenMaker\" > nul

echo.
echo ========================================
echo   Done! exe in dist\TokenMaker\
echo.
echo   Included: templates, static, token_rings, presets
echo   icon.ico, mask.png, logo.png, example.png
echo   Place model.onnx next to TokenMaker.exe
echo ========================================
echo.
pause

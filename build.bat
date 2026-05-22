@echo off
setlocal
chcp 65001 >nul

echo ========================================
echo   AI SSH Client - Build
echo ========================================
echo.

cd /d "%~dp0"
set "NSIS_DIR=src-tauri\target\release\bundle\nsis"
set "SETUP_NAME=AI SSH Client Setup 1.0.0.exe"
set "SETUP_PATH=%NSIS_DIR%\%SETUP_NAME%"

echo [1/3] Checking dependencies...
if not exist "node_modules" (
    echo node_modules not found. Running npm install...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed.
        pause
        exit /b 1
    )
)

echo.
echo Select build type:
echo   [1] Build Windows installer (NSIS)
echo   [2] Build executable only (no installer)
echo   [3] Build frontend assets only
echo.
set "choice=%~1"
if not defined choice set /p "choice=Enter option 1-3: "
if defined choice echo Selected option: %choice%

echo.
if "%choice%"=="1" (
    echo [2/3] Building Windows installer...
    call npm run tauri -- build --bundles nsis
) else if "%choice%"=="2" (
    echo [2/3] Building executable...
    call npm run tauri -- build --no-bundle
) else if "%choice%"=="3" (
    echo [2/3] Building frontend assets...
    call npm run build:renderer
) else (
    echo Invalid option.
    pause
    exit /b 1
)

if errorlevel 1 (
    echo.
    echo Build failed.
    echo If installer build failed but exe was generated, check NSIS/WiX availability or network access.
    echo Exe path: src-tauri\target\release\ai-ssh-client.exe
    pause
    exit /b 1
)

echo.
echo [3/3] Build completed.
echo.
if "%choice%"=="1" (
    for %%F in ("%NSIS_DIR%\*.exe") do (
        if /I not "%%~nxF"=="%SETUP_NAME%" copy /Y "%%~fF" "%SETUP_PATH%" >nul
    )
    echo Installer output: %SETUP_PATH%
    explorer src-tauri\target\release\bundle\nsis
) else if "%choice%"=="2" (
    echo Exe output: src-tauri\target\release
    explorer src-tauri\target\release
) else (
    echo Frontend output: dist\renderer
    explorer dist\renderer
)
pause

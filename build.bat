@echo off
chcp 65001 >nul
echo ========================================
echo   AI SSH Client - 应用构建器
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] 检查依赖...
if not exist "node_modules" (
    echo 依赖未安装，正在运行 npm install...
    call npm install
    if errorlevel 1 (
        echo.
        echo ❌ 依赖安装失败！
        pause
        exit /b 1
    )
)

echo.
echo 请选择构建类型：
echo   [1] 快速打包（不生成安装包）
echo   [2] 完整构建（NSIS 安装包 + 便携版）
echo   [3] 仅便携版
echo   [4] 仅安装包
echo.
set /p choice="请输入选项 (1-4): "

echo.
if "%choice%"=="1" (
    echo [2/3] 开始快速打包...
    call npm run pack
) else if "%choice%"=="2" (
    echo [2/3] 开始完整构建...
    call npm run dist:win
) else if "%choice%"=="3" (
    echo [2/3] 开始构建便携版...
    call npm run dist:portable
) else if "%choice%"=="4" (
    echo [2/3] 开始构建安装包...
    call npm run dist:win
) else (
    echo ❌ 无效选项！
    pause
    exit /b 1
)

if errorlevel 1 (
    echo.
    echo ❌ 构建失败！
    pause
    exit /b 1
)

echo.
echo [3/3] 构建完成！
echo.
echo ✅ 输出目录: release\
echo.
explorer release
pause

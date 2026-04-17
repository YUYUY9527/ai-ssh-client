@echo off
chcp 65001 >nul
echo ========================================
echo   AI SSH Client - 开发模式启动器
echo ========================================
echo.

cd /d "%~dp0"

echo [1/2] 检查依赖...
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

echo [2/2] 启动开发模式...
echo.
echo 💡 提示：按 Ctrl+C 可停止程序
echo.
call npm run dev

pause

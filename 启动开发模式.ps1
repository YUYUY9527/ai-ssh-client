# AI SSH Client 开发模式启动器 (PowerShell)
# 使用说明：右键 -> 使用 PowerShell 运行

$ErrorActionPreference = "Stop"

# 设置控制台编码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AI SSH Client - 开发模式启动器" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 切换到脚本所在目录
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# 检查依赖
Write-Host "[1/2] 检查依赖..." -ForegroundColor Yellow
if (-not (Test-Path "node_modules")) {
    Write-Host "依赖未安装，正在运行 npm install..." -ForegroundColor Magenta
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "❌ 依赖安装失败！" -ForegroundColor Red
        Read-Host "按回车键退出"
        exit 1
    }
}

# 启动开发模式
Write-Host "[2/2] 启动开发模式..." -ForegroundColor Yellow
Write-Host ""
Write-Host "💡 提示：按 Ctrl+C 可停止程序" -ForegroundColor Gray
Write-Host ""

npm run dev

Read-Host "按回车键退出"

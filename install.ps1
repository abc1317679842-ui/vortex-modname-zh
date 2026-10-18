#Requires -Version 5.1
<#
  Vortex 汉化扩展 一键安装脚本

  用法（PowerShell，两行）：
    Invoke-WebRequest '<release 里本文件的地址>' -OutFile "$env:TEMP\vortex-zh-install.ps1"
    powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\vortex-zh-install.ps1"
  （不要用一行管道执行：GitHub 资产不带编码声明，PS 5.1 会按 Latin-1 解码，中文全乱）

  做的事：检测 Vortex 进程 → 下载最新 release → 解压到扩展目录 → 提示后续步骤
  不改注册表、不改系统设置、不写扩展目录以外的任何位置（临时 zip 除外，装完即删）
#>

$ErrorActionPreference = 'Stop'

$Repo  = 'abc1317679842-ui/vortex-modname-zh'
$Asset = 'vortex-modname-zh.zip'
$Dest  = Join-Path $env:APPDATA 'Vortex\plugins\vortex-modname-zh'
$Url   = "https://github.com/$Repo/releases/latest/download/$Asset"

Write-Host ''
Write-Host '  Vortex 汉化扩展 · 安装程序' -ForegroundColor Cyan
Write-Host '  --------------------------------' -ForegroundColor DarkGray

# 1. Vortex 必须完全退出，否则文件占用会导致解压失败
$proc = Get-Process -Name 'Vortex' -ErrorAction SilentlyContinue
if ($proc) {
    Write-Host '  检测到 Vortex 正在运行。' -ForegroundColor Yellow
    Write-Host '  请完全退出（包括右下角托盘里的图标），然后按回车继续。' -ForegroundColor Yellow
    Read-Host | Out-Null
    $proc = Get-Process -Name 'Vortex' -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host '  Vortex 仍在运行，安装中止。关掉后再运行一次。' -ForegroundColor Red
        return
    }
}

# 2. 下载
$Tmp = Join-Path $env:TEMP ("vortex-zh-" + [guid]::NewGuid().ToString('N') + '.zip')
Write-Host "  下载最新版：$Url" -ForegroundColor DarkGray
try {
    Invoke-WebRequest -Uri $Url -OutFile $Tmp -UseBasicParsing -TimeoutSec 120
} catch {
    Write-Host "  下载失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  可以手动下载：$Url" -ForegroundColor Yellow
    return
}

# 3. 解压（保留已有 config.json —— 老版本用户的数据可能还在扩展目录里）
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$CfgPath = Join-Path $Dest 'config.json'
$CfgOld  = $null
if (Test-Path $CfgPath) {
    try { $CfgOld = [System.IO.File]::ReadAllText($CfgPath) } catch { $CfgOld = $null }
}
try {
    Expand-Archive -Path $Tmp -DestinationPath $Dest -Force
} catch {
    Write-Host "  解压失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  （多半是 Vortex 还占着文件，完全退出后再试）' -ForegroundColor Yellow
    Remove-Item $Tmp -Force -ErrorAction SilentlyContinue
    return
}
if ($CfgOld) {
    [System.IO.File]::WriteAllText($CfgPath, $CfgOld, (New-Object System.Text.UTF8Encoding($false)))
}
Remove-Item $Tmp -Force -ErrorAction SilentlyContinue

# 4. 校验关键文件
$Missing = @('index.js', 'info.json', 'pack.json') | Where-Object { -not (Test-Path (Join-Path $Dest $_)) }
if ($Missing) {
    Write-Host "  解压不完整，缺少：$($Missing -join ', ')" -ForegroundColor Red
    return
}

# 5. 后续步骤（用户必须自己点，脚本没法替）
Write-Host ''
Write-Host '  安装完成。还剩三步（都很重要）：' -ForegroundColor Green
Write-Host '    1. 启动 Vortex，然后重启两次（第一次写语言包，第二次才加载）'
Write-Host '    2. 设置 → 界面 → 语言 → 中文（简体），再重启一次'
Write-Host '    3. 设置 → 模组名汉化 → 填接口地址和模型名'
Write-Host ''
Write-Host "  安装目录：$Dest" -ForegroundColor DarkGray
Write-Host '  第 2 步不做的话，界面不会变中文（词库写了但不会被加载）。' -ForegroundColor Yellow
Write-Host ''

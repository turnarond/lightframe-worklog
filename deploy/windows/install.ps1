<#
  Lightframe Sync · Windows 离线安装
  用法（管理员 PowerShell）：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
  可选参数：-Port 8080 -DataDir "C:\ProgramData\lightframe-sync\data" -SkipFirewall

  只做四件事：定位/安装 Node、建数据目录、生成 start.cmd、注册计划任务 + 防火墙入站规则。
  不写注册表、不改系统服务、不需要任何账号口令。
#>
[CmdletBinding()]
param(
  [int]$Port = 8080,
  [string]$DataDir = "$env:ProgramData\lightframe-sync\data",
  [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'LightframeSync'
$RuleName = 'Lightframe Sync'

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请以管理员身份运行：右键 PowerShell → 以管理员身份运行，再执行本脚本。'
  }
}

function Resolve-NodeExe {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @(
      "$env:ProgramFiles\nodejs\node.exe",
      "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

Assert-Admin

$root = $PSScriptRoot
$server = Join-Path $root 'server-lite\server.js'
if (-not (Test-Path $server)) { throw "找不到 $server —— 请确认已完整解压部署包（不要只拷单个文件）。" }
if (-not (Test-Path (Join-Path $root 'src\syncCode.js'))) { throw '缺少 src\syncCode.js，部署包不完整。' }

# 1) Node.js（服务端零 npm 依赖，只要 node.exe 即可）
$nodeExe = Resolve-NodeExe
if (-not $nodeExe) {
  Write-Host '未检测到 Node.js，尝试用 winget 安装 LTS ...' -ForegroundColor Yellow
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw '未安装 Node.js 且没有 winget。请手动安装 Node.js LTS（https://nodejs.org）后重跑本脚本。'
  }
  & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  $nodeExe = Resolve-NodeExe
  if (-not $nodeExe) {
    throw 'Node.js 已安装但当前会话找不到 node.exe，请新开一个管理员 PowerShell 再跑一次。'
  }
}
Write-Host "Node: $nodeExe"

# 2) 数据目录 + 收紧权限（同步码派生的数据只给 SYSTEM/Administrators）
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
try {
  & icacls $DataDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
  Write-Host "数据目录: $DataDir"
} catch {
  Write-Warning "目录权限设置失败，建议手动收紧：$_"
}

# 3) 生成 start.cmd（计划任务靠它带 PORT/DATA_DIR 环境变量）
$startCmd = Join-Path $root 'start.cmd'
$template = @'
@echo off
set "PORT=__PORT__"
set "DATA_DIR=__DATA__"
set "MAX_BODY=1048576"
"__NODE__" "%~dp0server-lite\server.js"
'@
$body = $template.Replace('__PORT__', [string]$Port)
$body = $body.Replace('__DATA__', $DataDir)
$body = $body.Replace('__NODE__', $nodeExe)
[IO.File]::WriteAllText($startCmd, $body, [Text.Encoding]::ASCII)
Write-Host "已生成: $startCmd"

# 4) 防火墙：只放行 Private/Domain，不对 Public 网络开放
if (-not $SkipFirewall) {
  if (-not (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP `
      -LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null
    Write-Host "已放行入站 TCP $Port（仅 Private/Domain）"
  }
}

# 5) 计划任务：SYSTEM 身份、开机启动、崩溃自动重启
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$startCmd`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description '光影工作志 · 同步码服务端' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

# 6) 健康检查
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
  if (-not $health.ok) { throw '健康检查返回异常' }
} catch {
  throw "服务未通过健康检查：$($_.Exception.Message)。排查：Get-ScheduledTask -TaskName $TaskName；netstat -ano | findstr :$Port"
}

# 7) 输出客户端要填的地址
$ipv4 = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -First 1).IPAddress
if (-not $ipv4) { $ipv4 = '<本机内网IP>' }

Write-Host ''
Write-Host '安装完成' -ForegroundColor Green
Write-Host ("  本机检查 : http://127.0.0.1:{0}/api/health" -f $Port)
Write-Host ("  客户端填 : http://{0}:{1}" -f $ipv4, $Port)
Write-Host ("  数据目录 : {0}" -f $DataDir)
Write-Host ("  计划任务 : {0}（开机自启、崩溃重启）" -f $TaskName)
Write-Host ''
Write-Host '提示：当前为局域网明文 HTTP，同步码等价于完整数据访问权。若要外网访问，请先配置 HTTPS / 内网穿透，详见 README.md。' -ForegroundColor Yellow

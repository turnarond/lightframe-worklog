<#
  关闭 Cloudflare Tunnel（部署包内，管理员 PowerShell）
  默认保留配置与日志；-RemoveConfig 才删除，方便以后重新启用。
#>
[CmdletBinding()]
param([switch]$RemoveConfig)

$ErrorActionPreference = 'Stop'
$TaskName = 'LightframeSyncTunnel'
$stateDir = "$env:ProgramData\lightframe-sync"
$tunnelDir = Join-Path $stateDir 'tunnel'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请以管理员身份运行本脚本。'
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已移除计划任务: $TaskName"
} else {
  Write-Host '未找到 Tunnel 计划任务，跳过。'
}

$urlFile = Join-Path $stateDir 'tunnel-url.txt'
if (Test-Path $urlFile) { Remove-Item $urlFile -Force; Write-Host '已删除 tunnel-url.txt。' }

if ($RemoveConfig) {
  if (Test-Path $tunnelDir) {
    Remove-Item $tunnelDir -Recurse -Force
    Write-Host "已删除 Tunnel 配置目录: $tunnelDir" -ForegroundColor Yellow
  }
} else {
  Write-Host "配置已保留: $tunnelDir（如需删除，重跑时加 -RemoveConfig）"
}

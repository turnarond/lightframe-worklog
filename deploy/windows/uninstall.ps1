<#
  Lightframe Sync · Windows 卸载
  用法（管理员 PowerShell）：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
  默认保留数据目录；加 -RemoveData 才删除（不可恢复，请先备份）。
#>
[CmdletBinding()]
param([switch]$RemoveData)

$ErrorActionPreference = 'Stop'
$TaskName = 'LightframeSync'
$RuleName = 'Lightframe Sync'

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
  Write-Host '未找到计划任务，跳过。'
}

Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue
Write-Host '已移除防火墙规则。'

$startCmd = Join-Path $PSScriptRoot 'start.cmd'
if (Test-Path $startCmd) {
  Remove-Item $startCmd -Force
  Write-Host '已删除 start.cmd。'
}

$dataDir = "$env:ProgramData\lightframe-sync"
if ($RemoveData) {
  if (Test-Path $dataDir) {
    Remove-Item $dataDir -Recurse -Force
    Write-Host "已删除数据目录（不可恢复）: $dataDir" -ForegroundColor Yellow
  }
} else {
  Write-Host "数据目录已保留: $dataDir" -ForegroundColor Green
  Write-Host '如需删除，重跑时加 -RemoveData。'
}

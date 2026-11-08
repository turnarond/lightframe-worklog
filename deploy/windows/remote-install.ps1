<#
  SSH 部署用的远端入口：由 deploy-ssh.ps1 通过 scp 单独上传到目标机用户主目录，
  再以 `powershell -File` 执行（不用 stdin 管道：PowerShell 5.1 会在 stdin 开头写入 BOM，
  导致 -Command - 的第一条命令无法识别）。

  职责：解压部署包 → 调用 install.ps1 → health 自检 → 按需启用 Quick Tunnel。
#>
[CmdletBinding()]
param(
  [int]$Port = 8080,
  [ValidateSet('None', 'Quick')][string]$TunnelMode = 'None'
)

$ErrorActionPreference = 'Stop'
$zip = Join-Path $HOME 'lightframe-sync-server.zip'
$dst = Join-Path $HOME 'lightframe-sync'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'SSH 会话未获得管理员令牌。请在目标机上用 RDP / 本地管理员 PowerShell 手动执行一次 install.ps1。'
}

if (-not (Test-Path $zip)) { throw "找不到部署包：$zip" }
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $dst -Force

$install = Join-Path $dst 'install.ps1'
if (-not (Test-Path $install)) { throw '部署包内容不完整：缺少 install.ps1' }
& $install -Port $Port

$h = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/health" -f $Port) -TimeoutSec 5
Write-Host "REMOTE_HEALTH_OK service=$($h.service)"

if ($TunnelMode -eq 'Quick') {
  $enable = Join-Path $dst 'enable-tunnel.ps1'
  if (-not (Test-Path $enable)) { throw '部署包内缺少 enable-tunnel.ps1，无法启用 Tunnel' }
  & $enable -Mode Quick -Port $Port
}

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
# 远端输出统一 UTF-8，避免中文经 SSH 管道按 GBK/UTF-8 错配显示成乱码
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

$zip = Join-Path $HOME 'lightframe-sync-server.zip'
$dst = Join-Path $HOME 'lightframe-sync'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'SSH 会话未获得管理员令牌。请在目标机上用 RDP / 本地管理员 PowerShell 手动执行一次 install.ps1。'
}

if (-not (Test-Path $zip)) { throw "找不到部署包：$zip" }

# 重新部署：必须在删目录「之前」注销旧任务并释放 8080，
# 否则运行中的 node.exe 被文件锁占用，Remove-Item 会报「访问被拒绝」。
# 用 Unregister 而非 Stop，避免「崩溃自动重启」把进程又拉起来。
$oldTask = Get-ScheduledTask -TaskName 'LightframeSync' -ErrorAction SilentlyContinue
if ($oldTask) {
  Stop-ScheduledTask -TaskName 'LightframeSync' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName 'LightframeSync' -Confirm:$false -ErrorAction SilentlyContinue
}
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# 进程退出可能略有延迟，删除带重试
for ($i = 0; $i -lt 5; $i++) {
  try {
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force -ErrorAction Stop }
    break
  } catch {
    if ($i -eq 4) { throw }
    Start-Sleep -Seconds 1
  }
}
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

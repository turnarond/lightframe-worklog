<#
  通过 SSH 把离线部署包推送到目标 Windows 机器并完成安装。
  认证只用专用部署密钥（BatchMode=yes，绝不交互提示或传递口令）。

  前置：
    1) 本机已执行 npm run pack:sync 生成 dist/lightframe-sync-server.zip
    2) 目标机已安装 OpenSSH Server（22 可达）
    3) 本机公钥已加入目标机 C:\ProgramData\ssh\administrators_authorized_keys
       并已 Restart-Service sshd（见 deploy/windows/README.md）

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy-ssh.ps1 -Target 192.168.31.32
    npm run deploy:ssh -- -Target 192.168.31.32
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$User = 'Administrator',
  [int]$SshPort = 22,
  [int]$Port = 8080,
  [string]$Key = "$env:USERPROFILE\.ssh\lightframe_deploy_ed25519",
  [switch]$UploadOnly,
  [switch]$EnableTunnel
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$zip = Join-Path $repo 'dist\lightframe-sync-server.zip'
$remoteZip = 'lightframe-sync-server.zip'

if (-not (Test-Path $zip)) { throw "找不到 $zip —— 请先执行 npm run pack:sync" }
if (-not (Test-Path $Key)) { throw "找不到部署私钥 $Key —— 请先生成密钥对" }

$common = @(
  '-i', $Key,
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=8',
  '-o', 'LogLevel=ERROR'
)
$sshArgs = $common + @('-p', [string]$SshPort, ('{0}@{1}' -f $User, $Target))
$scpArgs = $common + @('-P', [string]$SshPort)

# 1) 认证与 shell 探测（失败立即退出，不会卡在密码提示）
Write-Host '--- SSH 认证探测 ---'
# native 命令写 stderr 时，Stop 会抛 NativeCommandError 打断脚本；临时降级以收集可读错误
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $probe = (& ssh.exe @sshArgs 'echo SSH_OK' 2>&1 | Out-String).Trim()
  $probeExit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $prevEap
}
# 以退出码为准：native stderr 被 PowerShell 包成 ErrorRecord 时，回显里含完整命令行
# （其中包含 'echo SSH_OK' 字样），只匹配字符串会误判认证成功。
if ($probeExit -ne 0 -or $probe -notmatch '(?m)^SSH_OK\s*$') {
  throw @"
SSH 认证失败：$probe
请确认公钥已加入目标机 C:\ProgramData\ssh\administrators_authorized_keys，
文件 ACL 为 SYSTEM + Administrators，并已 Restart-Service sshd。
"@
}
Write-Host 'SSH 认证通过（密钥方式，无口令交互）'

# 2) 传包
Write-Host '--- 上传部署包 ---'
$dest = ('{0}@{1}:{2}' -f $User, $Target, $remoteZip)
$ErrorActionPreference = 'Continue'
try { & scp.exe @scpArgs $zip $dest } finally { $ErrorActionPreference = $prevEap }
if ($LASTEXITCODE -ne 0) { throw 'scp 上传失败' }
Write-Host ("已上传 {0} ({1} MB)" -f $remoteZip, [math]::Round((Get-Item $zip).Length / 1MB, 1))

if ($UploadOnly) {
  Write-Host '仅上传模式，跳过安装。'
  return
}

# 3) 远端解压 + 安装（脚本经 stdin 传给远端 powershell，避开多层引号嵌套）
$remoteScript = @'
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'SSH 会话未获得管理员令牌。请在目标机上用 RDP / 本地管理员 PowerShell 手动执行一次 install.ps1。'
}
$zip = Join-Path $HOME 'lightframe-sync-server.zip'
$dst = Join-Path $HOME 'lightframe-sync'
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $dst -Force
& (Join-Path $dst 'install.ps1') -Port __PORT__
$h = Invoke-RestMethod "http://127.0.0.1:__PORT__/api/health" -TimeoutSec 5
Write-Host "REMOTE_HEALTH_OK service=$($h.service)"
$tunnelMode = '__TUNNEL_MODE__'
if ($tunnelMode -eq 'Quick') {
  & (Join-Path $dst 'enable-tunnel.ps1') -Mode Quick -Port __PORT__
}
'@
$remoteScript = $remoteScript.Replace('__PORT__', [string]$Port)
$remoteScript = $remoteScript.Replace('__TUNNEL_MODE__', $(if ($EnableTunnel) { 'Quick' } else { '' }))

Write-Host '--- 远端安装 ---'
$ErrorActionPreference = 'Continue'
try {
  $output = $remoteScript | & ssh.exe @sshArgs 'powershell -NoProfile -ExecutionPolicy Bypass -Command -' 2>&1 | Out-String
} finally {
  $ErrorActionPreference = $prevEap
}
$sshExit = $LASTEXITCODE
Write-Host $output.Trim()
if ($sshExit -ne 0 -or $output -notmatch 'REMOTE_HEALTH_OK') {
  throw '远端安装未完成或健康检查失败，详见上方输出。'
}

# 4) 跨机验证（确认防火墙规则真的放行）
Write-Host '--- 跨机访问验证 ---'
try {
  $health = Invoke-RestMethod -Uri ("http://{0}:{1}/api/health" -f $Target, $Port) -TimeoutSec 5
  if (-not $health.ok) { throw '健康检查返回异常' }
  Write-Host ("LAN_HEALTH_OK：http://{0}:{1} 可访问" -f $Target, $Port) -ForegroundColor Green
} catch {
  Write-Warning ("目标机本机自检通过，但从这台机器访问 {0}:{1} 失败：{2}" -f $Target, $Port, $_.Exception.Message)
  Write-Warning '常见原因：目标机网络位置为「公用」（防火墙规则仅放行 专用/域），或中间设备隔离了客户端。'
}

$tunnelMatch = [regex]::Match($output, 'TUNNEL_URL=(https://\S+)')
Write-Host ''
Write-Host ('局域网「服务器地址」：http://{0}:{1}' -f $Target, $Port) -ForegroundColor Green
if ($tunnelMatch.Success) {
  Write-Host ("外网「服务器地址」：{0}" -f $tunnelMatch.Groups[1].Value) -ForegroundColor Green
  Write-Host '提醒：Quick Tunnel 域名每次重启会变，长期使用请改用 -Mode Named 稳定域名。' -ForegroundColor Yellow
}
Write-Host '然后在设置 → 多设备同步里生成/填入同步码即可。'

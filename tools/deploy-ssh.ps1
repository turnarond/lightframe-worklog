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
  [switch]$EnableTunnel,
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
# 远端脚本已按 UTF-8 输出，本地读取 native stdout 也统一 UTF-8，避免中文日志乱码
[Console]::OutputEncoding = [Text.Encoding]::UTF8
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

# 2) 传包 + 远端入口脚本
Write-Host '--- 上传部署包 ---'
$dest = ('{0}@{1}:{2}' -f $User, $Target, $remoteZip)
$remoteEntry = 'lightframe-sync-remote.ps1'
$entrySrc = Join-Path $repo 'deploy\windows\remote-install.ps1'
$entryDest = ('{0}@{1}:{2}' -f $User, $Target, $remoteEntry)
$ErrorActionPreference = 'Continue'
try {
  & scp.exe @scpArgs $zip $dest
  $zipExit = $LASTEXITCODE
  & scp.exe @scpArgs $entrySrc $entryDest
  $entryExit = $LASTEXITCODE
} finally { $ErrorActionPreference = $prevEap }
if ($zipExit -ne 0 -or $entryExit -ne 0) { throw 'scp 上传失败' }
Write-Host ("已上传 {0} ({1} MB) 与远端入口脚本" -f $remoteZip, [math]::Round((Get-Item $zip).Length / 1MB, 1))

if ($UploadOnly) {
  Write-Host '仅上传模式，跳过安装。'
  return
}

# 3) 远端执行：用 -File 调用单独上传的入口脚本。
#    不用 `powershell -Command -` + stdin：PowerShell 5.1 经管道写入时会在开头加 BOM，
#    远端会把 BOM 当成第一条命令的一部分而报「无法识别」。
$tunnelMode = $(if ($EnableTunnel) { 'Quick' } else { 'None' })
$remoteCmd = ('powershell -NoProfile -ExecutionPolicy Bypass -File {0} -Port {1} -TunnelMode {2}' -f $remoteEntry, $Port, $tunnelMode)

Write-Host '--- 远端安装 ---'
$ErrorActionPreference = 'Continue'
try {
  $output = (& ssh.exe @sshArgs $remoteCmd 2>&1 | Out-String)
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

# 5) 端到端同步验证：真实 HTTP + 两个独立 SyncEngine（模拟两台设备）
if (-not $SkipVerify) {
  Write-Host '--- 局域网端到端同步验证 ---'
  $ErrorActionPreference = 'Continue'
  try {
    & node.exe (Join-Path $repo 'tools\verify-lan.js') ("http://{0}:{1}" -f $Target, $Port)
    $e2eExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prevEap }
  if ($e2eExit -ne 0) { throw '局域网端到端同步验证未通过，详见上方输出' }
  Write-Host 'LAN_E2E_OK' -ForegroundColor Green
}

$tunnelMatch = [regex]::Match($output, 'TUNNEL_URL=(https://\S+)')
Write-Host ''
Write-Host ('局域网「服务器地址」：http://{0}:{1}' -f $Target, $Port) -ForegroundColor Green
if ($tunnelMatch.Success) {
  Write-Host ("外网「服务器地址」：{0}" -f $tunnelMatch.Groups[1].Value) -ForegroundColor Green
  Write-Host '提醒：Quick Tunnel 域名每次重启会变，长期使用请改用 -Mode Named 稳定域名。' -ForegroundColor Yellow
}
Write-Host '然后在设置 → 多设备同步里生成/填入同步码即可。'

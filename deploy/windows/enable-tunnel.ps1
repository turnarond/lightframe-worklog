<#
  Cloudflare Tunnel 启用（部署包内，管理员 PowerShell）

  Quick（默认）：零账号、零域名，立刻得到 https://xxx.trycloudflare.com
    .\enable-tunnel.ps1
    注意：Quick 域名每次重启会变，客户端要重新填；仅适合验证 / 临时使用。

  Named：稳定域名，需域名托管在 Cloudflare，且先交互式登录一次：
    .\runtime\cloudflared.exe tunnel login
    .\enable-tunnel.ps1 -Mode Named -Hostname sync.example.com

  两种模式都注册计划任务开机自启，不需要公网 IP、端口映射或备案。
  输出含 TUNNEL_URL=... 一行，便于上层脚本捕获。
#>
[CmdletBinding()]
param(
  [ValidateSet('Quick', 'Named')][string]$Mode = 'Quick',
  [string]$Hostname,
  [string]$TunnelName = 'lightframe-sync',
  [int]$Port = 8080,
  [int]$WaitSeconds = 60,
  [string]$Cloudflared = (Join-Path $PSScriptRoot 'runtime\cloudflared.exe')
)

$ErrorActionPreference = 'Stop'
$TaskName = 'LightframeSyncTunnel'
$stateDir = "$env:ProgramData\lightframe-sync"
$tunnelDir = Join-Path $stateDir 'tunnel'
$urlFile = Join-Path $stateDir 'tunnel-url.txt'
$tunnelCmd = Join-Path $tunnelDir 'tunnel-run.cmd'
$configPath = Join-Path $tunnelDir 'config.yml'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请以管理员身份运行本脚本。'
}
if (-not (Test-Path $Cloudflared)) {
  throw "找不到 cloudflared.exe：$Cloudflared。请执行 npm run fetch:cloudflared 后重新打包部署包。"
}
New-Item -ItemType Directory -Force -Path $tunnelDir | Out-Null

try {
  $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/health" -f $Port) -TimeoutSec 5
  if (-not $health.ok) { throw '健康检查返回异常' }
} catch {
  throw ("本机 {0} 端口未检测到同步服务，请先运行 install.ps1：{1}" -f $Port, $_.Exception.Message)
}

if ($Mode -eq 'Quick') {
  $log = Join-Path $tunnelDir 'quick-tunnel.log'
  if (Test-Path $log) { Remove-Item $log -Force }
  $cmdText = @"
@echo off
"$Cloudflared" tunnel --no-autoupdate --url http://127.0.0.1:$Port --logfile "$log"
"@
  [IO.File]::WriteAllText($tunnelCmd, $cmdText, [Text.Encoding]::ASCII)
  $url = $null
} else {
  $cert = Join-Path $env:USERPROFILE '.cloudflared\cert.pem'
  if (-not (Test-Path $cert)) {
    throw @"
未找到 $cert。请先在目标机交互式执行：
  "$Cloudflared" tunnel login
（会打开浏览器，选择已托管到 Cloudflare 的域名），完成后再运行本脚本。
"@
  }
  if (-not $Hostname) { throw 'Named 模式需要 -Hostname sync.example.com' }

  $created = (& $Cloudflared tunnel create $TunnelName 2>&1 | Out-String)
  $m = [regex]::Match($created, 'with id\s+([0-9a-fA-F-]{36})')
  if ($m.Success) {
    $uuid = $m.Groups[1].Value
  } else {
    $list = (& $Cloudflared tunnel list 2>&1 | Out-String)
    $m2 = [regex]::Match($list, '([0-9a-fA-F-]{36})\s+' + [regex]::Escape($TunnelName))
    if (-not $m2.Success) { throw ("创建或查找 Tunnel 失败：`n" + $created + "`n" + $list) }
    $uuid = $m2.Groups[1].Value
  }

  & $Cloudflared tunnel route dns $TunnelName $Hostname 2>&1 | Out-Null
  $srcCred = Join-Path (Join-Path $env:USERPROFILE '.cloudflared') ($uuid + '.json')
  if (-not (Test-Path $srcCred)) { throw "找不到 Tunnel 凭据：$srcCred" }
  $cred = Join-Path $tunnelDir ($uuid + '.json')
  Copy-Item $srcCred $cred -Force

  $config = "tunnel: $uuid`r`n" +
            "credentials-file: $cred`r`n" +
            "ingress:`r`n" +
            "  - hostname: $Hostname`r`n" +
            "    service: http://127.0.0.1:$Port`r`n" +
            "  - service: http_status:404`r`n"
  [IO.File]::WriteAllText($configPath, $config, [Text.Encoding]::ASCII)
  $cmdText = @"
@echo off
"$Cloudflared" tunnel --no-autoupdate --config "$configPath" run
"@
  [IO.File]::WriteAllText($tunnelCmd, $cmdText, [Text.Encoding]::ASCII)
  $url = 'https://' + $Hostname
}

# 注册计划任务（SYSTEM、开机自启、崩溃重启）
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$tunnelCmd`"" -WorkingDirectory $tunnelDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $taskPrincipal -Description '光影工作志 · Cloudflare Tunnel' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host ("已启动计划任务 {0}（{1} 模式）" -f $TaskName, $Mode)

if ($Mode -eq 'Quick') {
  $log = Join-Path $tunnelDir 'quick-tunnel.log'
  Write-Host '正在等待 Cloudflare 分配临时域名 ...'
  for ($i = 0; $i -lt $WaitSeconds; $i++) {
    Start-Sleep -Seconds 1
    $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
    if ($text) {
      $match = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
      if ($match.Success) { $url = $match.Value; break }
    }
  }
  if (-not $url) {
    Write-Warning "未在 $WaitSeconds 秒内取得 Quick Tunnel 地址。常见原因：本机访问 Cloudflare 不通。查看日志 $log"
    return
  }
}

Set-Content -Path $urlFile -Value $url -Encoding ASCII
Write-Host "TUNNEL_URL=$url"
Write-Host ''
Write-Host '客户端「服务器地址」填上面这个 HTTPS 地址（末尾不要带 /）。' -ForegroundColor Green
if ($Mode -eq 'Quick') {
  Write-Host '提醒：Quick Tunnel 域名每次重启都会变，届时客户端需重新填写；长期使用请用 -Mode Named。' -ForegroundColor Yellow
}

# 下载 cloudflared Windows 二进制到 dist/tools/（供 pack:sync 打进部署包）
# dist/ 已被 gitignore，二进制不会入库。用法：npm run fetch:cloudflared
param([switch]$Force)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $repo 'dist\tools'
$out = Join-Path $outDir 'cloudflared.exe'

if ((Test-Path $out) -and -not $Force) {
  Write-Host ("已存在，跳过: {0} ({1} MB)" -f $out, [math]::Round((Get-Item $out).Length / 1MB, 1))
  return
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
Write-Host "下载 $url ..."
Invoke-WebRequest -Uri $url -OutFile $out -TimeoutSec 180 -UseBasicParsing
Write-Host ("完成: {0} ({1} MB)" -f $out, [math]::Round((Get-Item $out).Length / 1MB, 1))

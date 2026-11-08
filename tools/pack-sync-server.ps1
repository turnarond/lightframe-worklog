# 把同步码服务端组装成可拷贝的 Windows 离线部署包
# 用法：npm run pack:sync  →  dist/lightframe-sync-server.zip
# 默认把本机 node.exe 一起打进包（目标机无需安装 Node）；-NoBundleNode 可生成纯文本小包。
param([switch]$NoBundleNode)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP ('lightframe-sync-pack-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$outDir = Join-Path $repo 'dist'
$zip = Join-Path $outDir 'lightframe-sync-server.zip'

$required = @(
  'server-lite\server.js',
  'src\syncCode.js',
  'deploy\windows\install.ps1',
  'deploy\windows\uninstall.ps1',
  'deploy\windows\enable-tunnel.ps1',
  'deploy\windows\disable-tunnel.ps1',
  'deploy\windows\remote-install.ps1',
  'deploy\windows\README.md'
)
foreach ($f in $required) {
  if (-not (Test-Path (Join-Path $repo $f))) { throw "缺少必需文件: $f" }
}

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'server-lite') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'src') | Out-Null
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null

  Copy-Item (Join-Path $repo 'server-lite\server.js') (Join-Path $stage 'server-lite\server.js')
  Copy-Item (Join-Path $repo 'src\syncCode.js') (Join-Path $stage 'src\syncCode.js')
  Copy-Item (Join-Path $repo 'deploy\windows\install.ps1') (Join-Path $stage 'install.ps1')
  Copy-Item (Join-Path $repo 'deploy\windows\uninstall.ps1') (Join-Path $stage 'uninstall.ps1')
  Copy-Item (Join-Path $repo 'deploy\windows\README.md') (Join-Path $stage 'README.md')
  Copy-Item (Join-Path $repo 'deploy\windows\enable-tunnel.ps1') (Join-Path $stage 'enable-tunnel.ps1')
  Copy-Item (Join-Path $repo 'deploy\windows\disable-tunnel.ps1') (Join-Path $stage 'disable-tunnel.ps1')
  Copy-Item (Join-Path $repo 'deploy\windows\remote-install.ps1') (Join-Path $stage 'remote-install.ps1')

  # Windows PowerShell 5.1 按 ANSI 读取无 BOM 的 .ps1，中文会造成引号错乱；
  # 无论仓库源文件是否带 BOM，产物统一写成 UTF-8 with BOM。
  foreach ($name in @('install.ps1', 'uninstall.ps1', 'enable-tunnel.ps1',
                      'disable-tunnel.ps1', 'remote-install.ps1')) {
    $ps1 = Join-Path $stage $name
    $text = [IO.File]::ReadAllText($ps1, [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText($ps1, $text, (New-Object Text.UTF8Encoding($true)))
  }

  # 自带 node.exe，目标机零前置（避免通过 SSH 非交互调用 winget 安装失败）
  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'runtime') | Out-Null
  if (-not $NoBundleNode) {
    $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    Copy-Item $nodeExe (Join-Path $stage 'runtime\node.exe')
    Write-Host ("已打包 Node 运行时: {0} ({1} MB)" -f $nodeExe, [math]::Round((Get-Item $nodeExe).Length / 1MB, 1))
  }

  # cloudflared：外网访问（Cloudflare Tunnel）用，可选
  $cf = Join-Path $repo 'dist\tools\cloudflared.exe'
  if (Test-Path $cf) {
    Copy-Item $cf (Join-Path $stage 'runtime\cloudflared.exe')
    Write-Host ("已打包 cloudflared: {0} MB" -f [math]::Round((Get-Item $cf).Length / 1MB, 1))
  } else {
    Write-Warning '未找到 dist/tools/cloudflared.exe：部署包不含 Tunnel 运行时。执行 npm run fetch:cloudflared 后重新打包即可。'
  }

  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

  Write-Host "已生成: $zip"
  Write-Host '包内文件：'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $archive.Entries | ForEach-Object { Write-Host ('  ' + $_.FullName) }
  } finally {
    $archive.Dispose()
  }
} finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
}

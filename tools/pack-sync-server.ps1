# 把同步码服务端组装成可拷贝的 Windows 离线部署包
# 用法：npm run pack:sync  →  dist/lightframe-sync-server.zip
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

  # Windows PowerShell 5.1 按 ANSI 读取无 BOM 的 .ps1，中文会造成引号错乱；
  # 无论仓库源文件是否带 BOM，产物统一写成 UTF-8 with BOM。
  foreach ($name in @('install.ps1', 'uninstall.ps1')) {
    $ps1 = Join-Path $stage $name
    $text = [IO.File]::ReadAllText($ps1, [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText($ps1, $text, (New-Object Text.UTF8Encoding($true)))
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

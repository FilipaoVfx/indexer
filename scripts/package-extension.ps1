param(
  [string]$OutputDir = "dist",
  [string]$OutputName = "x-bookmarks-extension.zip"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$extensionDir = Join-Path $repoRoot "extension"
$outDir = Join-Path $repoRoot $OutputDir
$outZip = Join-Path $outDir $OutputName

if (!(Test-Path $extensionDir)) {
  throw "Extension directory not found: $extensionDir"
}

if (!(Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

if (Test-Path $outZip) {
  Remove-Item -LiteralPath $outZip -Force
}

Compress-Archive -Path (Join-Path $extensionDir "*") -DestinationPath $outZip -Force
Write-Output "Packaged extension: $outZip"

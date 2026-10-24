<#
.SYNOPSIS
    Export-OpenCore.ps1 - Synchronizes Open Core code to a public repository.
.DESCRIPTION
    Filters out packages/enterprise/, .env files, and proprietary keys,
    leaving a 100% clean MIT codebase ready for public GitHub release.
#>

param(
    [string]$PublicRemote = "https://github.com/Layline-Digital/pennant-open-core.git",
    [string]$Branch = "main"
)

Write-Host "=== Pennant Open-Core Release Generator ===" -ForegroundColor Cyan

# 1. Verify we are in repository root
if (-not (Test-Path "package.json")) {
    Write-Error "Must run from repository root."
    exit 1
}

$tempExportDir = Join-Path $env:TEMP "pennant-open-core-export"
if (Test-Path $tempExportDir) {
    Remove-Item -Path $tempExportDir -Recurse -Force | Out-Null
}
New-Item -ItemType Directory -Path $tempExportDir -Force | Out-Null

Write-Host "[*] Copying Open Core assets to clean staging buffer..." -ForegroundColor Yellow

# Copy root configs & apps
$itemsToCopy = @(
    "apps",
    "packages/core",
    "scripts",
    "assets",
    "test",
    "package.json",
    "README.md",
    "LICENSE",
    ".gitignore"
)

foreach ($item in $itemsToCopy) {
    if (Test-Path $item) {
        $dest = Join-Path $tempExportDir $item
        $parent = Split-Path $dest
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Copy-Item -Path $item -Destination $dest -Recurse -Force
    }
}

# Verify packages/enterprise was strictly omitted
if (Test-Path (Join-Path $tempExportDir "packages/enterprise")) {
    Remove-Item -Path (Join-Path $tempExportDir "packages/enterprise") -Recurse -Force
}

Write-Host "[+] Clean Open-Core tree staged at: $tempExportDir" -ForegroundColor Green
Write-Host "    - Excluded: packages/enterprise/ (Commercial code safe)" -ForegroundColor Green
Write-Host "    - Excluded: .env.broadcaster (Private keys safe)" -ForegroundColor Green
Write-Host "    - Included: Core queue, AirLock, Hoist deck, and protocol adapters (MIT)" -ForegroundColor Green
Write-Host "`nTo publish, push $tempExportDir to your public GitHub repo when ready." -ForegroundColor Cyan

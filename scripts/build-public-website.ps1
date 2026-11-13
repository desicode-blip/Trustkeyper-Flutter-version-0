param([Parameter(Mandatory = $true)][string]$Flutter)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'output\website-release\admin'
$pin = (Get-Content -LiteralPath (Join-Path $root '.flutter-version') -Raw).Trim()
$version = & $Flutter --version --machine | ConvertFrom-Json
if ($version.frameworkVersion -ne $pin) { throw "Use the pinned Flutter version $pin." }
Push-Location $root
try {
    python -X utf8 website/site/build.py
    if ($LASTEXITCODE -ne 0) { throw 'Website build failed.' }
    Push-Location (Join-Path $root 'apps\flutter_app')
    try {
        & $Flutter pub get --enforce-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'Locked Flutter dependencies could not be restored.' }
        & $Flutter build web --no-pub --target lib/admin_main.dart --base-href /admin/ --pwa-strategy=none --output $output
        if ($LASTEXITCODE -ne 0) { throw 'Admin portal build failed.' }
    } finally { Pop-Location }
    node scripts/assemble-website.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Website assembly failed.' }
    node --test scripts/test/staging-website.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Website verification failed.' }
} finally { Pop-Location }

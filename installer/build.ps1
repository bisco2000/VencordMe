# Builds VencordMe-Setup.exe (self-contained English installer)
# Usage:  powershell -ExecutionPolicy Bypass -File installer\build.ps1
param(
    [string]$Csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    [string]$Out = ""
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$dist = Join-Path $root "dist"
$payload = Join-Path $PSScriptRoot "payload"
$src = Join-Path $PSScriptRoot "Setup.cs"
$manifest = Join-Path $PSScriptRoot "setup.manifest"

if (-not $Out) { $Out = Join-Path $root "VencordMe-Setup.exe" }

if (-not (Test-Path $Csc)) { throw "csc.exe not found at $Csc" }

$distFiles = @("patcher.js", "preload.js", "renderer.js", "renderer.css",
               "patcher.js.LEGAL.txt", "renderer.js.LEGAL.txt")
foreach ($f in $distFiles) {
    if (-not (Test-Path (Join-Path $dist $f))) { throw "missing dist\$f - run pnpm buildStandalone first" }
}
foreach ($f in @("settings.json", "quickCss.css")) {
    if (-not (Test-Path (Join-Path $payload $f))) { throw "missing installer\payload\$f - run makeSettings.mjs first" }
}
if (-not (Test-Path $src)) { throw "missing $src" }

$lines = @(
    "/nologo",
    "/target:winexe",
    "/platform:anycpu",
    "/optimize+",
    "/langversion:5",
    "/debug-",
    "/warn:4",
    "/out:`"$Out`"",
    "/win32manifest:`"$manifest`"",
    "/r:System.dll",
    "/r:System.Core.dll",
    "/r:System.Drawing.dll",
    "/r:System.Windows.Forms.dll"
)

foreach ($f in $distFiles) {
    $lines += "/resource:`"$dist\$f`",$f"
}
$lines += "/resource:`"$payload\settings.json`",settings.json"
$lines += "/resource:`"$payload\quickCss.css`",quickCss.css"

# optional: your own settings profile (Install + Settings button / --with-profile)
$profileFile = Join-Path $payload "settings.mine.json"
if (Test-Path $profileFile) {
    $lines += "/resource:`"$profileFile`",settings.mine.json"
    Write-Host "Bundled settings profile: $profileFile"
} else {
    Write-Host "No settings profile (installer\payload\settings.mine.json) - Install + Settings stays disabled"
}
$lines += "`"$src`""

$rsp = Join-Path $env:TEMP "vencordme-setup.rsp"
Set-Content -LiteralPath $rsp -Value ($lines -join "`r`n") -Encoding ASCII

if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }

Write-Host "Compiling with $Csc"
& $Csc "@`"$rsp`""
$code = $LASTEXITCODE

Remove-Item -LiteralPath $rsp -Force -ErrorAction SilentlyContinue

if ($code -ne 0) { throw "csc failed with exit code $code" }
if (-not (Test-Path -LiteralPath $Out)) { throw "output not produced" }

$size = (Get-Item -LiteralPath $Out).Length
Write-Host ("OK  {0}  {1:N0} bytes ({2:N2} MB)" -f $Out, $size, ($size / 1MB))

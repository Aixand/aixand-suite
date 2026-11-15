param([switch]$WithoutVoice, [switch]$RuntimeOnly, [string]$OutputDirectory,
    [ValidateSet('distributed')][string]$Edition='distributed',
    [ValidateSet('desktop','client','server','both','all')][string]$Package='all',
    [string]$ProductReleases)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PYTHONUTF8 = '1'
if (-not [Environment]::Is64BitProcess -or $env:OS -ne 'Windows_NT') {
    throw 'Run this script in native 64-bit Windows PowerShell.'
}
if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    throw 'Install Rust with its MSVC toolchain and Microsoft C++ Build Tools (Desktop development with C++), then reopen PowerShell.'
}
$buildRoot = if ($OutputDirectory) { $OutputDirectory } else { Join-Path $env:USERPROFILE 'dev\aixand-windows-build' }
$cache = Join-Path $buildRoot 'cache\bootstrap'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$archive = Join-Path $cache 'uv-0.12.7-windows-x64.zip'
$expected = 'bf1518af459a3915511a11fdc6e2f43ef9a2afa138b9d498eeb9642fe9d85218'
if (-not (Test-Path $archive)) {
    Invoke-WebRequest 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-x86_64-pc-windows-msvc.zip' -OutFile $archive
}
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'The uv download checksum is incorrect. Delete the cached ZIP and retry.'
}
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $cache 'uv') -Force
$uv = Join-Path $cache 'uv\uv.exe'
$arguments = @('run', '--no-project', '--python', '3.12.14', 'python', (Join-Path $PSScriptRoot 'scripts\package-windows.py'), '--output', $buildRoot)
$arguments += @('--edition', $Edition)
$arguments += @('--package', $Package)
if ($ProductReleases) { $arguments += @('--product-releases', $ProductReleases) }
if ($WithoutVoice) { $arguments += '--without-voice' }
if ($RuntimeOnly) { $arguments += '--runtime-only' }
$env:PATH = "$(Split-Path $uv);$env:PATH"
& $uv @arguments
if ($LASTEXITCODE -ne 0) { throw "Windows package build failed (exit $LASTEXITCODE)." }

$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'scripts/dev.mjs') @args
exit $LASTEXITCODE

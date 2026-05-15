# Build the standalone stt-server.exe for either CPU or GPU flavor.
#
# Usage (from the repo root or anywhere — paths are resolved relative to
# this script):
#
#   pwsh server/packaging/build.ps1 -Flavor cpu
#   pwsh server/packaging/build.ps1 -Flavor gpu
#
# The script:
#   1. Resolves the venv to the requested flavor via ``uv sync --extra``
#   2. Runs PyInstaller using server/packaging/stt-server.spec
#   3. Copies the dist/stt-server/ folder to frontend/stt-server-dist-<flavor>/
#      where electron-builder reads it via extraResources.
#
# Idempotent: re-running with a different flavor just swaps the venv extras
# and rebuilds. ``--clean`` is passed to PyInstaller so stale binaries from
# the previous flavor never sneak into the new dist.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("cpu", "gpu")]
    [string]$Flavor
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Resolve-Path (Join-Path $ScriptDir "..")
$RepoRoot = Resolve-Path (Join-Path $ServerDir "..")
$FrontendDir = Resolve-Path (Join-Path $RepoRoot "frontend")
$DistTarget = Join-Path $FrontendDir "stt-server-dist-$Flavor"

Write-Host "==> Building stt-server ($Flavor flavor)" -ForegroundColor Cyan
Write-Host "    Server : $ServerDir"
Write-Host "    Target : $DistTarget"

Push-Location $ServerDir
try {
    Write-Host "==> Syncing venv with [$Flavor] extra" -ForegroundColor Cyan
    & uv sync --extra $Flavor --group dev
    if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }

    Write-Host "==> Running PyInstaller" -ForegroundColor Cyan
    & uv run pyinstaller packaging/stt-server.spec --clean --noconfirm --distpath dist --workpath dist/build
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

    $BuildOutput = Join-Path $ServerDir "dist/stt-server"
    if (-not (Test-Path $BuildOutput)) {
        throw "Expected PyInstaller output at $BuildOutput but it doesn't exist"
    }

    Write-Host "==> Copying build → $DistTarget" -ForegroundColor Cyan
    if (Test-Path $DistTarget) {
        Remove-Item -Recurse -Force $DistTarget
    }
    Copy-Item -Recurse -Path $BuildOutput -Destination $DistTarget

    Write-Host "==> Build complete: $DistTarget" -ForegroundColor Green
}
finally {
    Pop-Location
}

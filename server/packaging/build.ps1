# Build the standalone stt-server.exe for one of three EP flavors.
#
# Usage (from the repo root or anywhere — paths are resolved relative to
# this script):
#
#   pwsh server/packaging/build.ps1 -Flavor cpu
#   pwsh server/packaging/build.ps1 -Flavor directml   # default Windows GPU
#   pwsh server/packaging/build.ps1 -Flavor gpu        # NVIDIA-only legacy
#
# Flavor → ORT wheel mapping (driven by the pyproject ``[project.optional-
# dependencies]`` extras of the same name):
#
#   cpu       → onnxruntime (CPU-only)
#   directml  → onnxruntime-directml (DirectX 12 — AMD/Intel/NVIDIA, default
#               Windows GPU flavor as of the DirectML benchmark in the PR)
#   gpu       → onnxruntime-gpu + 8 NVIDIA cu12 wheels (CUDA EP, ~2 GB)
#
# The script:
#   1. Resolves the venv to the requested flavor via ``uv sync --extra``
#   2. Runs PyInstaller using server/packaging/stt-server.spec
#   3. Copies the dist/stt-server/ folder to
#      <repo>/packaging/stt-server-dist/<flavor>/ where
#      packaging/electron-builder.<flavor>.yml reads it via
#      ``extraResources: from: ../packaging/stt-server-dist/<flavor>/``
#      (resolved from projectDir = frontend, so ``..`` is the repo root).
#
# Idempotent: re-running with a different flavor just swaps the venv extras
# and rebuilds. ``--clean`` is passed to PyInstaller so stale binaries from
# the previous flavor never sneak into the new dist.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("cpu", "gpu", "directml")]
    [string]$Flavor
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Resolve-Path (Join-Path $ScriptDir "..")
$RepoRoot = Resolve-Path (Join-Path $ServerDir "..")
$DistTarget = Join-Path $RepoRoot "packaging\stt-server-dist\$Flavor"

Write-Host "==> Building stt-server ($Flavor flavor)" -ForegroundColor Cyan
Write-Host "    Server : $ServerDir"
Write-Host "    Target : $DistTarget"

Push-Location $ServerDir
try {
    Write-Host "==> Syncing venv with [$Flavor] extra" -ForegroundColor Cyan
    & uv sync --extra $Flavor --group dev
    if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }

    # pvporcupine<2.0.0 transitively pulls enum34 (Py2 backport). PyInstaller
    # refuses to run while it's installed. Remove it after every sync.
    # Wrap in cmd to keep PowerShell's $ErrorActionPreference='Stop' from
    # treating uv's stderr writes as a terminating error.
    cmd /c "uv pip uninstall enum34 1>nul 2>nul"

    Write-Host "==> Seeding offline base model (whisper-tiny q4)" -ForegroundColor Cyan
    # --no-sync: don't let `uv run` reinstall enum34 between the uninstall above
    # and PyInstaller below.
    & uv run --no-sync python packaging/seed_models.py --out packaging/seed-cache --quant q4
    if ($LASTEXITCODE -ne 0) { throw "seed model download failed" }

    Write-Host "==> Running PyInstaller" -ForegroundColor Cyan
    & uv run --no-sync pyinstaller packaging/stt-server.spec --clean --noconfirm --distpath dist --workpath dist/build
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

    $BuildOutput = Join-Path $ServerDir "dist/stt-server"
    if (-not (Test-Path $BuildOutput)) {
        throw "Expected PyInstaller output at $BuildOutput but it doesn't exist"
    }

    Write-Host "==> Copying build → $DistTarget" -ForegroundColor Cyan
    if (Test-Path $DistTarget) {
        Remove-Item -Recurse -Force $DistTarget
    }
    $DistParent = Split-Path -Parent $DistTarget
    if (-not (Test-Path $DistParent)) {
        New-Item -ItemType Directory -Force -Path $DistParent | Out-Null
    }
    Copy-Item -Recurse -Path $BuildOutput -Destination $DistTarget

    Write-Host "==> Build complete: $DistTarget" -ForegroundColor Green
}
finally {
    Pop-Location
}

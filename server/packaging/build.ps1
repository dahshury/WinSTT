# Build the standalone stt-server.exe for one of two Windows flavors.
#
# Usage (from the repo root or anywhere — paths are resolved relative to
# this script):
#
#   pwsh server/packaging/build.ps1 -Flavor cpu
#   pwsh server/packaging/build.ps1 -Flavor directml   # default Windows GPU
#   pwsh server/packaging/build.ps1 -Flavor openvino   # Intel ARC / Iris Xe
#
# Flavor → ORT wheel mapping (driven by the pyproject ``[project.optional-
# dependencies]`` extras of the same name):
#
#   cpu       → onnxruntime (CPU-only)
#   directml  → onnxruntime-directml (DirectX 12 — AMD/Intel/NVIDIA, default
#               Windows GPU flavor as of the DirectML benchmark in CLAUDE.md)
#   openvino  → onnxruntime-openvino (Intel ARC dGPU / Iris Xe iGPU /
#               Intel-vectorized CPU path). ~10-30 % uplift over DirectML
#               on Intel silicon; auto-picked ahead of DirectML when the
#               EP is registered (see device.py::_AUTO_PRIORITY).
#
# CUDA: the legacy ``-Flavor gpu`` path was retired for Windows because the
# DirectML EP is strictly better here (faster median, 12x lower stdev,
# 10x lighter — see CLAUDE.md). The ``[gpu]`` extra in pyproject.toml is
# kept for the future Linux NVIDIA build (device.py per-OS priority list
# still favors CUDA on Linux). On a Linux host this script will not run;
# a future build.sh will use ``uv sync --extra gpu`` directly.
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
# Idempotent: re-running with a different flavor just resyncs the
# flavor-specific build venv and rebuilds. ``--clean`` is passed to
# PyInstaller so stale binaries from a previous run never sneak into
# the new dist.
#
# ── Isolated build venv (do not touch the dev venv) ────────────────────
# Builds use a flavor-specific venv at ``server/.venv-build-<flavor>/``
# via the ``UV_PROJECT_ENVIRONMENT`` env var. Rationale: the dev venv at
# ``server/.venv/`` is held open by a live ``stt-server.exe`` whenever
# the user has ``bun electron:dev`` running, and uv cannot remove the
# CUDA DLLs it wants to swap for DirectML while those files are locked
# ("Access is denied" → ``uv sync failed``).
#
# An isolated build venv lets the dev process keep running undisturbed
# while packaging proceeds in a separate directory. The first build for
# each flavor pays a one-time wheel-resolution cost; subsequent rebuilds
# reuse the cached venv. Add ``-FreshVenv`` to wipe it (useful when
# pyproject extras change and you want a clean resolve).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("cpu", "directml", "openvino")]
    [string]$Flavor,
    # Wipe the flavor-specific build venv before syncing. Use when
    # pyproject.toml extras change or when the cached venv looks corrupt.
    [switch]$FreshVenv
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Resolve-Path (Join-Path $ScriptDir "..")
$RepoRoot = Resolve-Path (Join-Path $ServerDir "..")
$DistTarget = Join-Path $RepoRoot "packaging\stt-server-dist\$Flavor"
$BuildVenv = Join-Path $ServerDir ".venv-build-$Flavor"

# Point uv at the isolated build venv for every uv invocation below.
# ``uv sync`` and ``uv run`` both honor this env var, so the dev
# ``server/.venv/`` is never touched. Resolved to a real (long) path so
# uv writes activation scripts with non-relative shebangs.
$env:UV_PROJECT_ENVIRONMENT = $BuildVenv

Write-Host "==> Building stt-server ($Flavor flavor)" -ForegroundColor Cyan
Write-Host "    Server     : $ServerDir"
Write-Host "    Build venv : $BuildVenv"
Write-Host "    Target     : $DistTarget"

Push-Location $ServerDir
try {
    if ($FreshVenv -and (Test-Path $BuildVenv)) {
        Write-Host "==> -FreshVenv: removing existing build venv" -ForegroundColor Yellow
        Remove-Item -Recurse -Force $BuildVenv
    }

    Write-Host "==> Syncing build venv with [$Flavor] extra" -ForegroundColor Cyan
    & uv sync --extra $Flavor --group dev
    if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }

    # pvporcupine<2.0.0 transitively pulls enum34 (Py2 backport). PyInstaller
    # refuses to run while it's installed. Remove it after every sync.
    # ``uv pip`` (unlike ``uv sync``/``uv run``) does NOT honor
    # UV_PROJECT_ENVIRONMENT — it falls back to VIRTUAL_ENV or auto-discovers
    # .venv, which silently targets the WRONG venv when we are building into
    # .venv-build-<flavor>. Pass --python explicitly so it hits the build venv.
    # Wrap in cmd to keep PowerShell's $ErrorActionPreference='Stop' from
    # treating uv's stderr writes (e.g. when enum34 isn't installed) as a
    # terminating error.
    $BuildPython = Join-Path $BuildVenv "Scripts\python.exe"
    cmd /c "uv pip uninstall --python `"$BuildPython`" enum34 1>nul 2>nul"

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

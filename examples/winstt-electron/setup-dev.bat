@echo off
setlocal enabledelayedexpansion

:: ─────────────────────────────────────────────────────────────
::  WinSTT — Dev Environment Setup (Windows)
::
::  Usage:
::    setup-dev.bat                       Default: DirectML (any GPU via DX12; auto-falls-back to CPU)
::    setup-dev.bat --flavor directml     Force DirectML runtime (AMD/Intel/NVIDIA via DX12)
::    setup-dev.bat --flavor openvino     Force OpenVINO runtime (Intel ARC / Iris Xe / Arc iGPU)
::    setup-dev.bat --flavor cpu          Force CPU-only runtime
::
::  Prereqs handled automatically:
::    * uv         (Astral's Python toolchain)         — installed if missing
::    * Bun        (JS runtime + package manager)      — installed if missing
::    * Python 3.11 (managed by uv)
::
::  Prereqs you must already have:
::    * Git
::
::  No MSVC / Visual Studio Build Tools needed — the only native pieces
::  (uiohook-napi prebuilt NAPI binary + winstt-paste / winstt-context
::  helpers committed under frontend/electron/native/bin/) ship prebuilt.
:: ─────────────────────────────────────────────────────────────

echo.
echo  ============================================
echo   WinSTT Dev Environment Setup
echo  ============================================
echo.

:: ── Parse args ─────────────────────────────────
set "FLAVOR="
:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--flavor" (
    set "FLAVOR=%~2"
    shift
    shift
    goto parse_args
)
echo  [ERROR] Unknown argument: %~1
echo  Usage: setup-dev.bat [--flavor cpu^|directml^|openvino]
exit /b 1
:args_done

:: ── Check Git ──────────────────────────────────
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Git is not installed. Download from https://git-scm.com/
    pause
    exit /b 1
)

:: ── Detect flavor ─────────────────────────────────────────────
:: DirectML works on AMD / Intel / NVIDIA via DirectX 12 — covers
:: virtually every desktop Windows machine made in the last decade,
:: so we default to it. The runtime in device.py auto-falls-back to
:: CPU on hosts without a D3D12-capable GPU, so the DirectML build
:: is the safe default for "any GPU likely present".
if not defined FLAVOR (
    set "FLAVOR=directml"
    echo  Defaulting to DirectML runtime ^(AMD/Intel/NVIDIA via DX12; falls back to CPU automatically^).
) else (
    if /i not "%FLAVOR%"=="cpu" if /i not "%FLAVOR%"=="directml" if /i not "%FLAVOR%"=="openvino" (
        echo  [ERROR] --flavor must be 'cpu', 'directml', or 'openvino', got '%FLAVOR%'
        exit /b 1
    )
    echo  Manual flavor override: %FLAVOR%
)
echo.

:: ── uv ─────────────────────────────────────────
where uv >nul 2>&1
if %errorlevel% neq 0 (
    echo  [1/5] Installing uv...
    powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
    set "PATH=%USERPROFILE%\.local\bin;%PATH%"
    where uv >nul 2>&1
    if !errorlevel! neq 0 (
        echo  [ERROR] uv installation failed. Install manually: https://docs.astral.sh/uv/
        pause
        exit /b 1
    )
    echo  uv installed.
) else (
    echo  [1/5] uv already installed.
)

:: ── Bun ────────────────────────────────────────
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo  [2/5] Installing Bun...
    powershell -ExecutionPolicy ByPass -c "irm https://bun.sh/install.ps1 | iex"
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
    where bun >nul 2>&1
    if !errorlevel! neq 0 (
        echo  [ERROR] Bun installation failed. Install manually: https://bun.sh/
        pause
        exit /b 1
    )
    echo  Bun installed.
) else (
    echo  [2/5] Bun already installed.
)

:: ── Python 3.11 via uv ─────────────────────────
:: requires-python is ">=3.11" but the project is developed and tested on
:: 3.11; pin it so uv (and ``uv run stt-server``) don't grab a newer
:: interpreter that lacks matching onnxruntime / torch wheels.
echo  [3/5] Provisioning Python 3.11 via uv...
uv python install 3.11
if %errorlevel% neq 0 (
    echo  [ERROR] Failed to install Python 3.11 via uv.
    pause
    exit /b 1
)
uv python pin 3.11 --directory "%~dp0server" >nul 2>&1

:: ── Server deps ────────────────────────────────
:: onnx-asr is resolved as a git URL from winstt/onnx-asr (see
:: server/pyproject.toml [tool.uv.sources]) — no separate clone step.
echo  [4/5] Installing server dependencies (%FLAVOR%)...
pushd "%~dp0server"
uv sync --python 3.11 --extra %FLAVOR%
if %errorlevel% neq 0 (
    echo  [ERROR] Server dependency installation failed.
    popd
    pause
    exit /b 1
)
popd
echo  Server dependencies installed.

:: ── Frontend + root deps ───────────────────────
echo  [5/5] Installing frontend + root dependencies...
pushd "%~dp0frontend"
call bun install
if %errorlevel% neq 0 (
    echo  [ERROR] Frontend dependency installation failed.
    popd
    pause
    exit /b 1
)
:: Ensure Electron binary was downloaded (Bun may skip a dependency's
:: own postinstall, so electron's install.js never runs).
if not exist "node_modules\electron\dist\electron.exe" (
    echo  Electron binary missing, running install script...
    call bun run node_modules/electron/install.js
    if !errorlevel! neq 0 (
        echo  [ERROR] Failed to download the Electron binary.
        popd
        pause
        exit /b 1
    )
)
:: Regenerate TS types from the OpenAPI spec — non-fatal.
echo  Generating TypeScript types from OpenAPI spec...
call bun run generate
if %errorlevel% neq 0 (
    echo  [WARN] `bun generate` failed; using the committed schema.d.ts.
)
popd

:: Root install wires up husky pre-commit hooks (block ``git stash``,
:: etc) and installs electron-builder for `bun run electron:build:*`.
pushd "%~dp0"
call bun install
if %errorlevel% neq 0 (
    echo  [WARN] Root `bun install` failed; husky hooks and the .exe
    echo         packaging scripts at repo root won't be available.
)
popd
echo  Dependencies installed.

:: ── Done ───────────────────────────────────────
echo.
echo  ============================================
echo   Setup complete!  Flavor: %FLAVOR%
echo  ============================================
echo.
echo   Start the dev app:
echo     cd frontend
echo     bun electron:dev
echo.
echo   Or run the server standalone:
echo     cd server
echo     uv run stt-server
echo.
echo   Build a release installer ^(from repo root^):
echo     bun run electron:build:%FLAVOR%
echo.
pause

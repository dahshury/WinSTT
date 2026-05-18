@echo off
setlocal enabledelayedexpansion

echo.
echo  ============================================
echo   WinSTT Dev Environment Setup
echo  ============================================
echo.

:: ── Check Git ──────────────────────────────────
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Git is not installed. Download from https://git-scm.com/
    pause
    exit /b 1
)

:: ── Check / Install uv ─────────────────────────
where uv >nul 2>&1
if %errorlevel% neq 0 (
    echo  [1/6] Installing uv...
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
    echo  [1/6] uv already installed.
)

:: ── Check / Install Bun ────────────────────────
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo  [2/6] Installing Bun...
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
    echo  [2/6] Bun already installed.
)

:: ── Provision Python 3.11 ──────────────────────
:: requires-python is ">=3.11" but the project is developed and tested on
:: 3.11; pin it so uv (and later `uv run stt-server`) don't grab a newer
:: interpreter that lacks matching onnxruntime / torch wheels.
echo  [3/6] Provisioning Python 3.11 via uv...
uv python install 3.11
if %errorlevel% neq 0 (
    echo  [ERROR] Failed to install Python 3.11 via uv.
    pause
    exit /b 1
)
uv python pin 3.11 --directory "%~dp0server" >nul 2>&1

:: ── Clone onnx-asr if missing ──────────────────
:: Editable path dependency of the server (../examples/onnx-asr); must
:: exist before `uv sync` or resolution fails.
echo  [4/6] Checking onnx-asr dependency...
if not exist "%~dp0examples\onnx-asr\pyproject.toml" (
    if not exist "%~dp0examples" mkdir "%~dp0examples"
    echo  Cloning onnx-asr into examples\onnx-asr...
    git clone https://github.com/istupakov/onnx-asr.git "%~dp0examples\onnx-asr"
    if !errorlevel! neq 0 (
        echo  [ERROR] Failed to clone onnx-asr.
        pause
        exit /b 1
    )
) else (
    echo  onnx-asr already present.
)

:: ── Install server deps ────────────────────────
echo  [5/6] Installing server dependencies (Python 3.11 + ONNX packages)...
echo  Installing the CPU runtime by default. For NVIDIA GPU acceleration,
echo  re-run later with: cd server ^&^& uv sync --extra gpu
echo.
pushd "%~dp0server"
uv sync --python 3.11 --extra cpu
if %errorlevel% neq 0 (
    echo  [ERROR] Server dependency installation failed.
    popd
    pause
    exit /b 1
)
popd
echo  Server dependencies installed.

:: ── Install frontend deps ──────────────────────
echo  [6/6] Installing frontend dependencies...
pushd "%~dp0frontend"
call bun install
if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] Frontend dependency installation failed.
    echo.
    echo  The most common cause is the native postinstall step
    echo  ^(electron-rebuild / uiohook-napi^) failing because a C/C++
    echo  toolchain is missing. Install "Visual Studio Build Tools"
    echo  with the "Desktop development with C++" workload, then
    echo  re-run this script:
    echo    https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo.
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
:: Regenerate TS types from the OpenAPI spec so a fresh checkout's
:: generated schema matches spec/openapi.yaml. Non-fatal: the file is
:: committed, so a failure here doesn't block development.
echo  Generating TypeScript types from OpenAPI spec...
call bun run generate
if %errorlevel% neq 0 (
    echo  [WARN] `bun generate` failed; using the committed schema.d.ts.
)
popd
echo  Frontend dependencies installed.

:: ── Done ───────────────────────────────────────
echo.
echo  ============================================
echo   Setup complete!
echo  ============================================
echo.
echo   Start the server:
echo     cd server
echo     uv run stt-server
echo.
echo   Start the Electron app (separate terminal):
echo     cd frontend
echo     bun electron:dev
echo.
pause

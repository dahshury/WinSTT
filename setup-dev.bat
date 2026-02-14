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

:: ── Check / Install Bun ────────────────────────
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

:: ── Clone onnx-asr if missing ──────────────────
echo  [3/5] Checking onnx-asr dependency...
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
echo  [4/5] Installing server dependencies (Python 3.11 + packages)...
echo  This may take several minutes on first run (downloads PyTorch ~2.4 GB).
echo.
pushd "%~dp0server"
uv sync
if %errorlevel% neq 0 (
    echo  [ERROR] Server dependency installation failed.
    popd
    pause
    exit /b 1
)
popd
echo  Server dependencies installed.

:: ── Install frontend deps ──────────────────────
echo  [5/5] Installing frontend dependencies...
pushd "%~dp0frontend"
call bun install
if %errorlevel% neq 0 (
    echo  [ERROR] Frontend dependency installation failed.
    popd
    pause
    exit /b 1
)
:: Ensure Electron binary was downloaded (Bun may skip postinstall)
if not exist "node_modules\electron\dist\electron.exe" (
    echo  Electron binary missing, running install script...
    call bun run node_modules/electron/install.js
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

# WinSTT Tauri dev launcher (PowerShell).
#
# Why PowerShell instead of the .bat: cmd.exe prints "Terminate batch job (Y/N)?" whenever
# Ctrl+C interrupts a running batch command — there is no way to suppress that in pure cmd.
# PowerShell has no such prompt: Ctrl+C forwards to the dev server and returns straight to
# the prompt. Paired with the Windows console-ctrl handler in src-tauri (which makes the app
# exit with code 0 on Ctrl+C), a single Ctrl+C now closes everything cleanly — no prompt, no
# "process didn't exit successfully", no WebView2 teardown warning.
#
# Run it directly from a PowerShell terminal:
#     .\rust-migration\tauri-dev.ps1

$ErrorActionPreference = 'Stop'

$vcvars = 'C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) {
    throw "vcvars64.bat not found at '$vcvars'. Edit `$vcvars in this script to point at your VS install."
}

# Import the MSVC build environment (INCLUDE / LIB / PATH / ...) that vcvars64.bat exports,
# into THIS PowerShell session — the equivalent of `call vcvars64.bat` in the old .bat.
& cmd.exe /c "`"$vcvars`" >NUL 2>&1 && set" | ForEach-Object {
    $pair = $_ -split '=', 2
    if ($pair.Count -eq 2) { Set-Item -Path ("Env:" + $pair[0]) -Value $pair[1] }
}

# Prepend the toolchain dirs (bun / cargo / LLVM / CMake / Ninja) — same as the old .bat.
$prepend = @(
    'C:\Users\MASTE\.bun\bin'
    'C:\Users\MASTE\.cargo\bin'
    'C:\Program Files\LLVM\bin'
    'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'
    'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja'
) -join ';'
$env:PATH = "$prepend;$env:PATH"
$env:LIBCLANG_PATH = 'C:\Program Files\LLVM\bin'

Set-Location 'E:\DL\Projects\WinSTT'

# Free the dev ports first. Vite is configured strictPort:1420 (src-tauri devUrl), so a
# previous `tauri dev` that didn't shut down cleanly leaves a stale listener and the next
# launch dies with "Port 1420 is already in use". 1421 is the HMR port (remote-host mode).
# Stop whatever is LISTENING on them so the launch is self-healing.
$freedAny = $false
foreach ($port in 1420, 1421) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            if ($_ -and $_ -ne 0) {
                $proc = Get-Process -Id $_ -ErrorAction SilentlyContinue
                $name = if ($proc) { $proc.ProcessName } else { "pid $_" }
                Write-Host "Freeing port $port (stopping $name, pid $_)..."
                Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
                $freedAny = $true
            }
        }
}
if ($freedAny) { Start-Sleep -Milliseconds 400 }  # let the OS release the socket before vite binds

# Hand the console to the dev server. From here on a non-zero exit (e.g. a Ctrl+C-interrupted
# toolchain) must NOT surface as a red PowerShell error — let it pass through quietly.
$ErrorActionPreference = 'Continue'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $global:PSNativeCommandUseErrorActionPreference = $false
}

bun run tauri dev

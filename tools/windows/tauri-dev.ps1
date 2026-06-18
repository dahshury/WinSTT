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
#     .\tools\windows\tauri-dev.ps1

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

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
    (Join-Path $env:USERPROFILE '.bun\bin')
    (Join-Path $env:USERPROFILE '.cargo\bin')
    'C:\Program Files\LLVM\bin'
    'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'
    'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja'
) -join ';'
$env:PATH = "$prepend;$env:PATH"
$env:LIBCLANG_PATH = 'C:\Program Files\LLVM\bin'

# Force the first-run onboarding wizard to open on EVERY dev launch, regardless of
# the persisted `general.onboarded` flag (see is_force_onboarding_env_flag_set in
# src-tauri/src/lib.rs). Handy while iterating on the wizard — finishing it still
# sets onboarded=true, but this env var overrides that on the next launch so the
# wizard always reappears. Comment this line out to return to normal dev behaviour
# (onboarding only on a genuinely un-onboarded profile).
$env:WINSTT_FORCE_ONBOARDING = '1'

Set-Location $repoRoot

# Kill only this repo's leftover debug app first. Packaged/portable WinSTT may be
# running at the same time to own the dictation hotkey, so never stop every
# process named `winstt`.
$debugWinsttExe = Join-Path $repoRoot 'src-tauri\target\debug\winstt.exe'
Get-Process -Name winstt -ErrorAction SilentlyContinue |
    Where-Object {
        try {
            [string]::Equals($_.Path, $debugWinsttExe, [System.StringComparison]::OrdinalIgnoreCase)
        } catch {
            $false
        }
    } |
    ForEach-Object {
        Write-Host "Stopping stale dev app (winstt, pid $($_.Id))..."
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }

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

function Test-ExternalTerminationNoiseLine {
    param([string]$Line)

    return (
        $Line.Contains('[tao::platform_impl::platform::event_loop::runner][WARN] NewEvents emitted without explicit RedrawEventsCleared') -or
        $Line.Contains('[tao::platform_impl::platform::event_loop::runner][WARN] RedrawRequested dispatched without explicit MainEventsCleared') -or
        (
            $Line.Contains("process didn't exit successfully:") -and
            $Line.Contains('target\debug\winstt.exe') -and
            $Line.Contains('(exit code: 1)')
        ) -or
        $Line.Contains('script "tauri" exited with code 1')
    )
}

# Build + stage the native context sidecar (winstt_context) BEFORE handing off to
# `tauri dev`. It is a SEPARATE cargo bin that `tauri dev` does not build on its own,
# and nothing else copies it into place — without this, ContextManager can't resolve
# winstt-context.exe at runtime and context-awareness (the focused-field --split
# capture) silently no-ops. Best-effort: a sidecar build failure warns but does not
# abort the dev session (the app still runs, just without context capture). This runs
# after the 'Continue' handoff above, so cargo's exit code is checked, not thrown.
Write-Host "Building + staging the context sidecar (winstt_context)..."
& cargo build --manifest-path (Join-Path $repoRoot 'src-tauri\Cargo.toml') --bin winstt_context
if ($LASTEXITCODE -eq 0) {
    $binDir = Join-Path $repoRoot 'src-tauri\binaries'
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    Copy-Item -Force `
        -Path (Join-Path $repoRoot 'src-tauri\target\debug\winstt_context.exe') `
        -Destination (Join-Path $binDir 'winstt-context.exe')
    Write-Host "Staged winstt-context.exe -> src-tauri/binaries/."
} else {
    Write-Warning "Context sidecar build failed; context-awareness is disabled this run."
}

$tauriDevOutput = New-Object System.Collections.Generic.List[string]
$tauriDevTail = New-Object System.Collections.Generic.Queue[string]
$tauriDevTailLimit = 8
& bun run tauri dev 2>&1 | ForEach-Object {
    $line = $_.ToString()
    $tauriDevOutput.Add($line)
    $tauriDevTail.Enqueue($line)
    while ($tauriDevTail.Count -gt $tauriDevTailLimit) {
        Write-Host $tauriDevTail.Dequeue()
    }
}
$tauriDevExitCode = $LASTEXITCODE

if ($tauriDevExitCode -eq 0) {
    foreach ($line in $tauriDevTail) {
        Write-Host $line
    }
    exit 0
}

$tauriDevText = $tauriDevOutput -join "`n"
# Task Manager's forced termination gives the child process exit code 1 without
# delivering any shutdown event to Rust. Keep this match narrow so build errors
# and other dev-tool failures still fail the launcher.
$wasExternallyTerminated =
    $tauriDevText.Contains("process didn't exit successfully:") -and
    $tauriDevText.Contains('target\debug\winstt.exe') -and
    $tauriDevText.Contains('(exit code: 1)') -and
    $tauriDevText.Contains('script "tauri" exited with code 1')

if ($wasExternallyTerminated) {
    foreach ($line in $tauriDevTail) {
        if (-not (Test-ExternalTerminationNoiseLine $line)) {
            Write-Host $line
        }
    }
    Write-Host "WinSTT dev app was terminated externally; treating the dev session stop as clean."
    exit 0
}

foreach ($line in $tauriDevTail) {
    Write-Host $line
}
exit $tauriDevExitCode

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
$devPipelineStopwatch = [Diagnostics.Stopwatch]::StartNew()

# Keep native tool output UTF-8 end-to-end. Windows PowerShell otherwise decodes
# Cargo's Unicode progress glyphs through the active OEM code page (for example,
# the ellipsis becomes "Gamma-C..." mojibake in the console).
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

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
# Cargo's in-place progress bar is built from carriage returns. PowerShell's
# native-output pipeline cannot preserve that terminal behavior reliably, so
# request stable line-oriented build output instead.
$env:CARGO_TERM_PROGRESS_WHEN = 'never'

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

# Build + stage the native context sidecar before handing off to `tauri dev`.
# Its small standalone manifest deliberately bypasses the main app's build.rs and
# dependency graph. The shared target dir still reuses matching cached dependencies.
# Best-effort: a failure warns but does not abort the dev session.
Write-Host "Building + staging the context sidecar (winstt_context)..."
$sidecarManifest = Join-Path $repoRoot 'src-tauri\context-sidecar\Cargo.toml'
$targetDir = Join-Path $repoRoot 'src-tauri\target'
$sidecarStopwatch = [Diagnostics.Stopwatch]::StartNew()
& cargo build --manifest-path $sidecarManifest --target-dir $targetDir --bin winstt_context
$sidecarStopwatch.Stop()
Write-Host ("Context sidecar build check: {0:N2}s" -f $sidecarStopwatch.Elapsed.TotalSeconds)
if ($LASTEXITCODE -eq 0) {
    $binDir = Join-Path $repoRoot 'src-tauri\binaries'
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    $sidecarSource = Join-Path $targetDir 'debug\winstt_context.exe'
    $sidecarDestination = Join-Path $binDir 'winstt-context.exe'
    $sidecarChanged = -not (Test-Path -LiteralPath $sidecarDestination)
    if (-not $sidecarChanged) {
        $sourceInfo = Get-Item -LiteralPath $sidecarSource
        $destinationInfo = Get-Item -LiteralPath $sidecarDestination
        $sidecarChanged = $sourceInfo.Length -ne $destinationInfo.Length
        # Copy-Item preserves LastWriteTimeUtc, so matching size + timestamp is
        # the zero-I/O warm path. Hash only the unusual same-size/new-timestamp
        # case to avoid rewriting an identical deterministic linker output.
        if (-not $sidecarChanged -and $sourceInfo.LastWriteTimeUtc -ne $destinationInfo.LastWriteTimeUtc) {
            $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sidecarSource).Hash
            $destinationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sidecarDestination).Hash
            $sidecarChanged = $sourceHash -ne $destinationHash
        }
    }
    if ($sidecarChanged) {
        Copy-Item -Force -LiteralPath $sidecarSource -Destination $sidecarDestination
        Write-Host "Staged updated winstt-context.exe -> src-tauri/binaries/."
    } else {
        Write-Host "Context sidecar unchanged; staging skipped."
    }
} else {
    Write-Warning "Context sidecar build failed; context-awareness is disabled this run."
}

$deferredTerminationNoise = New-Object System.Collections.Generic.List[string]
$sawProcessExitFailure = $false
$sawDebugAppExit = $false
$sawTauriScriptExit = $false
$reportedRendererReady = $false
$reportedAppLaunch = $false
& bun run tauri dev 2>&1 | ForEach-Object {
    $line = $_.ToString()

    if (-not $reportedRendererReady -and $line.Contains('127.0.0.1:1420')) {
        $reportedRendererReady = $true
        Write-Host ("Renderer ready after {0:N2}s total." -f $devPipelineStopwatch.Elapsed.TotalSeconds)
    }
    if (-not $reportedAppLaunch -and $line.Contains('Running') -and $line.Contains('target\debug\winstt.exe')) {
        $reportedAppLaunch = $true
        Write-Host ("Development app launched after {0:N2}s total." -f $devPipelineStopwatch.Elapsed.TotalSeconds)
    }

    if ($line.Contains("process didn't exit successfully:")) {
        $sawProcessExitFailure = $true
    }
    if ($line.Contains('target\debug\winstt.exe') -and $line.Contains('(exit code: 1)')) {
        $sawDebugAppExit = $true
    }
    if ($line.Contains('script "tauri" exited with code 1')) {
        $sawTauriScriptExit = $true
    }

    # Stream normal output immediately. The previous eight-line tail queue made
    # each later app log flush one stale Cargo build line, so speaking appeared
    # to trigger another build. Only known shutdown-noise candidates need to be
    # held until the final exit status tells us whether they are meaningful.
    if (Test-ExternalTerminationNoiseLine $line) {
        $deferredTerminationNoise.Add($line)
    } else {
        Write-Host $line
    }
}
$tauriDevExitCode = $LASTEXITCODE

if ($tauriDevExitCode -eq 0) {
    exit 0
}

# Task Manager's forced termination gives the child process exit code 1 without
# delivering any shutdown event to Rust. Keep this match narrow so build errors
# and other dev-tool failures still fail the launcher.
$wasExternallyTerminated =
    $sawProcessExitFailure -and
    $sawDebugAppExit -and
    $sawTauriScriptExit

if ($wasExternallyTerminated) {
    Write-Host "WinSTT dev app was terminated externally; treating the dev session stop as clean."
    exit 0
}

foreach ($line in $deferredTerminationNoise) {
    Write-Host $line
}
exit $tauriDevExitCode

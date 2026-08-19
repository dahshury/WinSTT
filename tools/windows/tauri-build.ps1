param(
    [switch] $NoBundle,
    [string] $Bundles = "",
    [string] $Config = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")

function Find-VcVars64 {
    $Candidates = @()

    $VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $VsWhere) {
        $InstallPath = & $VsWhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($LASTEXITCODE -eq 0 -and $InstallPath) {
            $Candidates += (Join-Path $InstallPath "VC\Auxiliary\Build\vcvars64.bat")
        }
    }

    $Candidates += @(
        "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\17\Enterprise\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\17\Professional\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\17\Community\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    )

    foreach ($Candidate in $Candidates | Select-Object -Unique) {
        if (Test-Path -LiteralPath $Candidate) {
            return $Candidate
        }
    }

    throw "Could not find vcvars64.bat. Install Visual Studio Build Tools with the MSVC x64 toolchain."
}

function Import-VcVars {
    param([string] $VcVars)

    cmd /d /s /c "`"$VcVars`" >nul && set" | ForEach-Object {
        if ($_ -match "^([^=]+)=(.*)$") {
            Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
        }
    }
}

function Import-Llvm {
    $Candidates = @()
    if ($env:LLVM_BIN) {
        $Candidates += $env:LLVM_BIN
    }
    if ($env:LLVM_HOME) {
        $Candidates += (Join-Path $env:LLVM_HOME "bin")
    }
    $Candidates += "C:\Program Files\LLVM\bin"

    foreach ($Candidate in $Candidates | Select-Object -Unique) {
        $Linker = Join-Path $Candidate "lld-link.exe"
        if (Test-Path -LiteralPath $Linker) {
            $env:PATH = "$Candidate;$env:PATH"
            $env:LIBCLANG_PATH = $Candidate
            return
        }
    }

    # LLVM is a link-time optimization here, not a requirement: .cargo/config.toml selects
    # lld-link.exe because it links this binary several times faster than the MSVC linker.
    # Without LLVM installed that setting is a hard "linker not found" failure, so fall back
    # to the link.exe that Import-VcVars just put on PATH. Slower to link, but it builds.
    Write-Host "LLVM not found; using the MSVC linker (link.exe) instead of lld-link."
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = "link.exe"
}

function Assert-NonEmptyFile {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path,
        [Parameter(Mandatory = $true)]
        [string] $Description
    )

    $File = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if ($null -eq $File) {
        throw "Missing $Description required by the Windows bundle: $Path"
    }
    if ($File.PSIsContainer) {
        throw "Expected a file for $Description, found a directory: $Path"
    }
    if ($File.Length -le 0) {
        throw "Empty $Description required by the Windows bundle: $Path"
    }
}

if (-not $NoBundle -and -not $Bundles) {
    $NoBundle = $true
}

$BuildArgs = @(
    "--config",
    "src-tauri/tauri.windows.bundle.conf.json"
)
if ($NoBundle) {
    $BuildArgs += "--no-bundle"
}
if ($Bundles) {
    $BuildArgs += @("--bundles", $Bundles)
}
if ($Config) {
    $BuildArgs += @("--config", $Config)
}

Import-VcVars (Find-VcVars64)
Import-Llvm

Push-Location $RepoRoot
try {
    $BuildStopwatch = [Diagnostics.Stopwatch]::StartNew()
    # Build the native context sidecar before the bundle. Its standalone manifest
    # avoids running the full app build script and resolving the app-only graph;
    # the shared target dir keeps dependency artifacts reusable. The Tauri bundler
    # includes the finished target as `winstt_context.exe` next to the main binary.
    # Fatal here (unlike dev): a release that ships without the sidecar is broken.
    $SidecarManifest = Join-Path $RepoRoot "src-tauri\context-sidecar\Cargo.toml"
    $TargetDir = Join-Path $RepoRoot "src-tauri\target"
    $SidecarStopwatch = [Diagnostics.Stopwatch]::StartNew()
    cargo build --release --manifest-path $SidecarManifest --target-dir $TargetDir --bin winstt_context
    $SidecarStopwatch.Stop()
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to build the winstt_context sidecar (exit code $LASTEXITCODE)"
    }
    Write-Host ("Context sidecar release build: {0:N2}s" -f $SidecarStopwatch.Elapsed.TotalSeconds)
    $BinDir = Join-Path $RepoRoot "src-tauri\binaries"
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

    # Stage the native runtime DLLs winstt.exe needs at runtime (DirectML for the ORT
    # DML EP — a load-time import — plus the MSVC CRT). The release-only bundle
    # config maps binaries/runtime/*.dll next to winstt.exe; without them the
    # installed app cannot start on a machine without a dev toolchain. The sidecar build
    # above carries a Windows-only ORT staging dependency, so the ort build script has
    # placed DirectML.dll in target\release without compiling the full app first.
    # (tauri-portable.ps1 reuses this stage. sherpa-onnx DLLs are gone — wake-word KWS
    # runs natively on ort since the 2026-07 port.)
    $ReleaseDir = Join-Path $RepoRoot "src-tauri\target\release"
    $RuntimeDir = Join-Path $BinDir "runtime"
    if (Test-Path -LiteralPath $RuntimeDir) {
        Remove-Item -LiteralPath $RuntimeDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
    $OrtRuntimeDlls = @(
        "DirectML.dll"
    )
    foreach ($Dll in $OrtRuntimeDlls) {
        $Source = Join-Path $ReleaseDir $Dll
        if (-not (Test-Path -LiteralPath $Source)) {
            throw "Missing native runtime DLL: $Source (expected from the ort build script)"
        }
        Copy-Item -Force -LiteralPath $Source -Destination (Join-Path $RuntimeDir $Dll)
    }
    # App-local MSVC CRT: winstt.exe imports MSVCP140/MSVCP140_1; do not assume the
    # target machine has the VC++ redistributable installed.
    if (-not $env:VCToolsRedistDir) {
        throw "VCToolsRedistDir not set by vcvars64 - cannot stage MSVC CRT DLLs"
    }
    $CrtDir = Get-ChildItem -Path (Join-Path $env:VCToolsRedistDir "x64") -Filter "Microsoft.VC*.CRT" -Directory |
        Select-Object -First 1
    if ($null -eq $CrtDir) {
        throw "No Microsoft.VC*.CRT directory under $env:VCToolsRedistDir\x64"
    }
    # `winstt.exe` imports MSVCP140 + MSVCP140_1. Their transitive imports need
    # VCRUNTIME140 + VCRUNTIME140_1; MSVCP140_2 is not in the PE dependency chain.
    $CrtRuntimeDlls = @("msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll")
    foreach ($Dll in $CrtRuntimeDlls) {
        $Source = Join-Path $CrtDir.FullName $Dll
        if (-not (Test-Path -LiteralPath $Source)) {
            throw "Missing MSVC runtime DLL required by the Windows bundle: $Source"
        }
        Copy-Item -Force -LiteralPath $Source -Destination (Join-Path $RuntimeDir $Dll)
    }

    # Final bundle boundary: source checks above are not enough. A failed/truncated
    # copy or a zero-byte cargo output must never reach NSIS as a valid-looking file.
    $SidecarPath = Join-Path $ReleaseDir "winstt_context.exe"
    Assert-NonEmptyFile -Path $SidecarPath -Description "context sidecar"
    foreach ($Dll in $OrtRuntimeDlls + $CrtRuntimeDlls) {
        Assert-NonEmptyFile -Path (Join-Path $RuntimeDir $Dll) -Description "runtime DLL '$Dll'"
    }

    $TauriBuildStopwatch = [Diagnostics.Stopwatch]::StartNew()
    bun run tauri build @BuildArgs
    $TauriBuildStopwatch.Stop()
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE"
    }
    $BuildStopwatch.Stop()
    Write-Host ("Tauri/frontend build: {0:N2}s" -f $TauriBuildStopwatch.Elapsed.TotalSeconds)
    Write-Host ("Total build pipeline: {0:N2}s" -f $BuildStopwatch.Elapsed.TotalSeconds)
} finally {
    Pop-Location
}

# Bundle a previously-built stt-server onedir into a single portable .exe.
#
# Pipeline:
#   1. dotnet publish the .NET 8 self-contained launcher (PortableLauncher.exe,
#      ~12 MB compressed single-file).
#   2. 7z a the entire <repo>/packaging/stt-server-dist/<flavor>/ tree into bundle.7z
#      (LZMA2 -mx=7, ~2 GB for the GPU build).
#   3. Concat [launcher.exe][bundle.7z][24-byte footer] → final .exe. The
#      footer encodes the archive's offset and length so the launcher can
#      seek into its own file at runtime and stream the 7z to SharpCompress.
#
# First-launch runtime behaviour: prompts for an extraction folder via a
# native FolderBrowserDialog, extracts there, writes ".winstt-runtime"
# beside the wrapper with the chosen path. Subsequent launches read the
# marker, jump straight to running the inner stt-server.exe with full
# stdio inheritance + CLI arg forwarding + exit-code propagation.
#
# Usage (from anywhere):
#   pwsh server/packaging/build-portable.ps1 -Flavor gpu
#   pwsh server/packaging/build-portable.ps1 -Flavor cpu
#
# Requires:
#   - The onedir bundle at <repo>/packaging/stt-server-dist/<flavor>/ (run build.ps1 first)
#   - .NET 8 SDK or newer (`dotnet --list-sdks`)
#   - 7-Zip at C:\Program Files\7-Zip\7z.exe (or `7z` on PATH)

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("cpu", "gpu")]
    [string]$Flavor
)

$ErrorActionPreference = "Stop"

$ScriptDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir     = Resolve-Path (Join-Path $ScriptDir "..")
$RepoRoot      = Resolve-Path (Join-Path $ServerDir "..")
$SourceDir     = Join-Path $RepoRoot "packaging\stt-server-dist\$Flavor"
$LauncherProj  = Join-Path $ScriptDir "portable-launcher-dotnet"
$FlavorUpper   = $Flavor.ToUpper()
$OutFile       = Join-Path $RepoRoot "WinSTT-STT-Server-$FlavorUpper-Portable.exe"
$WorkDir       = Join-Path $ServerDir "dist/portable-$Flavor"
$PublishDir    = Join-Path $WorkDir "publish"
$ArchiveFile   = Join-Path $WorkDir "bundle.7z"
$LauncherExe   = Join-Path $PublishDir "PortableLauncher.exe"

if (-not (Test-Path $SourceDir)) {
    throw "Source bundle not found: $SourceDir`nRun ``pwsh server/packaging/build.ps1 -Flavor $Flavor`` first."
}
if (-not (Test-Path $LauncherProj)) {
    throw "Launcher project missing: $LauncherProj"
}

# Locate 7z.exe (PS 5.1-compatible)
$SevenZip = $null
$Cmd = Get-Command 7z -ErrorAction SilentlyContinue
if ($Cmd) { $SevenZip = $Cmd.Source }
if (-not $SevenZip) {
    foreach ($candidate in @(
        "C:\Program Files\7-Zip\7z.exe",
        "C:\Program Files (x86)\7-Zip\7z.exe"
    )) {
        if (Test-Path $candidate) { $SevenZip = $candidate; break }
    }
}
if (-not $SevenZip) {
    throw "7z not found. Install 7-Zip from https://www.7-zip.org/ or via ``winget install 7zip.7zip``."
}

# Locate dotnet
$DotNet = $null
$Cmd = Get-Command dotnet -ErrorAction SilentlyContinue
if ($Cmd) { $DotNet = $Cmd.Source }
if (-not $DotNet) {
    throw "dotnet not found. Install .NET 8 SDK or newer from https://dotnet.microsoft.com/."
}

Write-Host "==> Building portable wrapper ($FlavorUpper)" -ForegroundColor Cyan
Write-Host "    Source     : $SourceDir"
Write-Host "    Output     : $OutFile"
Write-Host "    Work dir   : $WorkDir"
Write-Host "    7z         : $SevenZip"
Write-Host "    dotnet     : $DotNet"
Write-Host ""

# ── Clean & prep ──────────────────────────────────────────────────────────
if (Test-Path $WorkDir) { Remove-Item -Recurse -Force $WorkDir }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
if (Test-Path $OutFile) { Remove-Item -Force $OutFile }

# ── Step 1: publish the .NET launcher ─────────────────────────────────────
Write-Host "==> [1/3] Publishing .NET launcher" -ForegroundColor Cyan
Push-Location $LauncherProj
try {
    & $DotNet publish `
        -c Release `
        -r win-x64 `
        --self-contained true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:EnableCompressionInSingleFile=true `
        -o $PublishDir `
        --nologo `
        -v minimal
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE)" }
}
finally {
    Pop-Location
}
if (-not (Test-Path $LauncherExe)) { throw "Launcher exe not produced at $LauncherExe" }
$LauncherSizeMB = [math]::Round((Get-Item $LauncherExe).Length / 1MB, 1)
Write-Host "    Launcher exe: $LauncherSizeMB MB"

# ── Step 2: create 7z archive of the onedir bundle ────────────────────────
Write-Host ""
Write-Host "==> [2/3] Compressing $Flavor bundle to 7z (LZMA2, mx=7)" -ForegroundColor Cyan
Write-Host "    (this is the long pole — expect 5–15 min for the GPU bundle)"
Push-Location $SourceDir
try {
    # -t7z LZMA2 -mx=7 (high, not ultra — mx=9 doubles RAM for ~3% gain)
    # -mfb=273 -ms=on   solid mode, large fast bytes
    # -mmt=on           parallel compression
    # -bsp1 -bso1       progress to stdout
    & $SevenZip a -t7z -mx=7 -mfb=273 -ms=on -mmt=on -bsp1 -bso1 $ArchiveFile "*"
    if ($LASTEXITCODE -ne 0) { throw "7z compression failed (exit $LASTEXITCODE)" }
}
finally {
    Pop-Location
}
$ArchiveSizeMB = [math]::Round((Get-Item $ArchiveFile).Length / 1MB, 1)
Write-Host "    Archive size: $ArchiveSizeMB MB"

# ── Step 3: concat launcher + archive + footer ────────────────────────────
Write-Host ""
Write-Host "==> [3/3] Concatenating into $OutFile" -ForegroundColor Cyan

$Magic = [System.Text.Encoding]::ASCII.GetBytes("WINSTT01")
if ($Magic.Length -ne 8) { throw "Magic must be exactly 8 bytes" }

$Out = [System.IO.File]::Create($OutFile)
try {
    # Launcher PE
    $In = [System.IO.File]::OpenRead($LauncherExe)
    try { $In.CopyTo($Out) } finally { $In.Dispose() }
    $ArchiveOffset = $Out.Position

    # 7z payload
    $In = [System.IO.File]::OpenRead($ArchiveFile)
    try { $In.CopyTo($Out) } finally { $In.Dispose() }
    $ArchiveLength = $Out.Position - $ArchiveOffset

    # Footer: 8-byte magic + 8-byte LE offset + 8-byte LE length
    $Out.Write($Magic, 0, 8)
    $Out.Write([System.BitConverter]::GetBytes([int64]$ArchiveOffset), 0, 8)
    $Out.Write([System.BitConverter]::GetBytes([int64]$ArchiveLength), 0, 8)
}
finally {
    $Out.Dispose()
}

# Sanity-check footer round-trips
$Verify = [System.IO.File]::OpenRead($OutFile)
try {
    $Verify.Seek(-24, [System.IO.SeekOrigin]::End) | Out-Null
    $Buf = New-Object byte[] 24
    $Read = $Verify.Read($Buf, 0, 24)
    if ($Read -ne 24) { throw "Footer read short ($Read bytes)" }
    $ReadMagic = [System.Text.Encoding]::ASCII.GetString($Buf, 0, 8)
    if ($ReadMagic -ne "WINSTT01") { throw "Footer magic verification failed: '$ReadMagic'" }
    $ReadOffset = [System.BitConverter]::ToInt64($Buf, 8)
    $ReadLength = [System.BitConverter]::ToInt64($Buf, 16)
    if ($ReadOffset -ne $ArchiveOffset -or $ReadLength -ne $ArchiveLength) {
        throw "Footer values mismatch (offset $ReadOffset vs $ArchiveOffset, length $ReadLength vs $ArchiveLength)"
    }
}
finally {
    $Verify.Dispose()
}

$FinalSizeGB = [math]::Round((Get-Item $OutFile).Length / 1GB, 2)
Write-Host ""
Write-Host "==> Done: $OutFile ($FinalSizeGB GB)" -ForegroundColor Green
Write-Host "    Archive @ offset $ArchiveOffset, length $ArchiveLength" -ForegroundColor DarkGray

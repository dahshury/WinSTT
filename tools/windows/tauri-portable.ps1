param(
    [string] $OutputDir = "",
    [switch] $SkipBuild,
    [switch] $NoZip
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$ReleaseDir = Join-Path $RepoRoot "src-tauri\target\release"
$DefaultOutput = Join-Path $RepoRoot "dist\WinSTT-portable"
$PortableDir = if ($OutputDir) { $OutputDir } else { $DefaultOutput }
$DistDir = Split-Path -Parent $PortableDir
$PortableExe = Join-Path $DistDir "WinSTT.exe"
$BuildScript = Join-Path $ScriptDir "tauri-build.ps1"
$CiBundleConfig = Join-Path $RepoRoot "tools\tauri-ci-artifacts.conf.json"

if (-not $SkipBuild) {
    & $BuildScript -Bundles "nsis" -Config $CiBundleConfig
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri release build failed with exit code $LASTEXITCODE"
    }
}

$WinsttExe = Join-Path $ReleaseDir "winstt.exe"
if (-not (Test-Path -LiteralPath $WinsttExe)) {
    throw "Missing release artifact: $WinsttExe"
}

# Runtime DLLs are staged once by tauri-build.ps1 (same set the NSIS bundle ships via
# tauri.windows.conf.json): DirectML + the MSVC CRT.
$RuntimeDir = Join-Path $RepoRoot "src-tauri\binaries\runtime"
$RuntimeDlls = @(Get-ChildItem -Path $RuntimeDir -Filter "*.dll" -File -ErrorAction SilentlyContinue)
if ($RuntimeDlls.Count -eq 0) {
    throw "No staged runtime DLLs in $RuntimeDir - run tools\windows\tauri-build.ps1 first"
}

$Resources = Join-Path $ReleaseDir "resources"
if (-not (Test-Path -LiteralPath $Resources)) {
    throw "Missing release resources directory: $Resources"
}

$NsisDir = Join-Path $ReleaseDir "bundle\nsis"
$NsisExe = Get-ChildItem -Path $NsisDir -Filter "*.exe" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($null -eq $NsisExe) {
    throw "Missing portable Windows exe bundle in: $NsisDir"
}

if (Test-Path -LiteralPath $PortableDir) {
    Remove-Item -LiteralPath $PortableDir -Recurse -Force
}
New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
New-Item -ItemType Directory -Path $PortableDir | Out-Null

Copy-Item -LiteralPath (Join-Path $ReleaseDir "winstt.exe") -Destination (Join-Path $PortableDir "WinSTT.exe") -Force
Copy-Item -LiteralPath $NsisExe.FullName -Destination $PortableExe -Force
foreach ($Dll in $RuntimeDlls) {
    Copy-Item -LiteralPath $Dll.FullName -Destination (Join-Path $PortableDir $Dll.Name) -Force
}
Copy-Item -LiteralPath $Resources -Destination (Join-Path $PortableDir "resources") -Recurse -Force
# Context-awareness sidecar (staged by tauri-build.ps1; resolved as $RESOURCE/binaries/winstt-context.exe).
$Sidecar = Join-Path $RepoRoot "src-tauri\binaries\winstt-context.exe"
if (-not (Test-Path -LiteralPath $Sidecar)) {
    throw "Missing context sidecar: $Sidecar - run tools\windows\tauri-build.ps1 first"
}
New-Item -ItemType Directory -Path (Join-Path $PortableDir "binaries") -Force | Out-Null
Copy-Item -LiteralPath $Sidecar -Destination (Join-Path $PortableDir "binaries\winstt-context.exe") -Force
Set-Content -LiteralPath (Join-Path $PortableDir "portable") -Value "WinSTT Portable Mode" -NoNewline -Encoding ASCII
New-Item -ItemType Directory -Path (Join-Path $PortableDir "Data") -Force | Out-Null

if (-not $NoZip) {
    $Zip = "$PortableDir.zip"
    if (Test-Path -LiteralPath $Zip) {
        Remove-Item -LiteralPath $Zip -Force
    }
    Compress-Archive -LiteralPath $PortableDir -DestinationPath $Zip -Force
}

Write-Host "Portable WinSTT package written to: $PortableDir"
Write-Host "Portable Windows exe written to: $PortableExe"
if (-not $NoZip) {
    Write-Host "Portable zip written to: $PortableDir.zip"
}

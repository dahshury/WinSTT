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

$RequiredFiles = @(
    "winstt.exe",
    "DirectML.dll",
    "onnxruntime.dll",
    "onnxruntime_providers_shared.dll",
    "sherpa-onnx-c-api.dll",
    "sherpa-onnx-cxx-api.dll"
)

foreach ($File in $RequiredFiles) {
    $Path = Join-Path $ReleaseDir $File
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing release artifact: $Path"
    }
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
foreach ($File in $RequiredFiles | Where-Object { $_ -ne "winstt.exe" }) {
    Copy-Item -LiteralPath (Join-Path $ReleaseDir $File) -Destination (Join-Path $PortableDir $File) -Force
}
Copy-Item -LiteralPath $Resources -Destination (Join-Path $PortableDir "resources") -Recurse -Force
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

param(
    [string] $AssetsRoot = "",
    [string] $Version = "",
    [string] $Tag = "",
    [string] $Title = "",
    [string] $Notes = "",
    [string] $Target = "",
    [bool] $Draft = $true,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI 'gh' was not found on PATH."
}

function Invoke-Gh {
    param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Arguments)

    & gh @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "gh $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

if (-not $AssetsRoot) {
    $AssetsRoot = Join-Path $RepoRoot "dist"
}
$AssetsRoot = Resolve-Path $AssetsRoot

if (-not $Version) {
    $TauriConfig = Get-Content -LiteralPath (Join-Path $RepoRoot "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
    $Version = $TauriConfig.version
}
if (-not $Tag) {
    $Tag = "v$Version"
}
if (-not $Title) {
    $Title = "WinSTT v$Version"
}
if (-not $Notes) {
    $Notes = "WinSTT $Version."
}
if (-not $Target) {
    Push-Location $RepoRoot
    try {
        $Target = (& git rev-parse HEAD).Trim()
    } finally {
        Pop-Location
    }
}

$RequiredWindowsAssets = @(
    (Join-Path $AssetsRoot "WinSTT.exe"),
    (Join-Path $AssetsRoot "WinSTT-portable.zip")
)

$Assets = @()
foreach ($Asset in $RequiredWindowsAssets) {
    if (-not (Test-Path -LiteralPath $Asset)) {
        throw "Missing required Windows release asset: $Asset"
    }
    $Assets += Get-Item -LiteralPath $Asset
}

$LinuxAssets = @(
    Get-ChildItem -LiteralPath $AssetsRoot -Recurse -File |
        Where-Object { $_.Extension -in @(".AppImage", ".deb", ".rpm") } |
        Sort-Object FullName
)

if ($LinuxAssets.Count -eq 0) {
    throw "Missing Linux release assets under: $AssetsRoot"
}
$Assets += $LinuxAssets

if ($DryRun) {
    Write-Host "Dry run: would upload release assets to ${Tag}:"
    foreach ($Asset in $Assets) {
        Write-Host "  $($Asset.FullName)"
    }
    return
}

$PreviousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    & gh release view $Tag 1>$null 2>$null
    $ReleaseExists = $LASTEXITCODE -eq 0
} finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
}

if ($ReleaseExists) {
    Invoke-Gh release edit $Tag --title $Title --notes $Notes
} else {
    $CreateArgs = @("release", "create", $Tag, "--target", $Target, "--title", $Title, "--notes", $Notes)
    if ($Draft) {
        $CreateArgs += "--draft"
    } else {
        $CreateArgs += "--latest"
    }
    Invoke-Gh @CreateArgs
}

foreach ($Asset in $Assets) {
    Invoke-Gh release upload $Tag $Asset.FullName --clobber
}

Write-Host "Uploaded release assets to ${Tag}:"
foreach ($Asset in $Assets) {
    Write-Host "  $($Asset.Name)"
}

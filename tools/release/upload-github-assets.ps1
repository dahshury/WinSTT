param(
    [string] $AssetsRoot = "",
    [string] $Version = "",
    [string] $Tag = "",
    [string] $Title = "",
    [string] $Notes = "",
    [string] $Repository = "dahshury/WinSTT",
    [string] $Target = "",
    [bool] $Draft = $true,
    [bool] $Prerelease = $false,
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

function Get-GitHubReleaseAssetUrl {
    param(
        [string] $Repository,
        [string] $Tag,
        [string] $AssetName
    )

    $EncodedTag = [System.Uri]::EscapeDataString($Tag)
    $EncodedName = [System.Uri]::EscapeDataString($AssetName)
    "https://github.com/$Repository/releases/download/$EncodedTag/$EncodedName"
}

function Read-UpdaterSignature {
    param([string] $Path)

    (Get-Content -LiteralPath $Path -Raw).Trim()
}

function New-UpdaterManifest {
    param(
        [string] $Repository,
        [string] $Tag,
        [string] $Version,
        [string] $Notes,
        [System.IO.FileInfo] $WindowsAsset,
        [System.IO.FileInfo] $WindowsSignature,
        [System.IO.FileInfo] $LinuxAppImage,
        [System.IO.FileInfo] $LinuxSignature
    )

    [ordered] @{
        version = $Version
        notes = $Notes
        pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        platforms = [ordered] @{
            "windows-x86_64" = [ordered] @{
                signature = Read-UpdaterSignature $WindowsSignature.FullName
                url = Get-GitHubReleaseAssetUrl $Repository $Tag $WindowsAsset.Name
            }
            "linux-x86_64" = [ordered] @{
                signature = Read-UpdaterSignature $LinuxSignature.FullName
                url = Get-GitHubReleaseAssetUrl $Repository $Tag $LinuxAppImage.Name
            }
        }
    }
}

function Get-ReleaseAssetByName {
    param(
        [string] $Root,
        [string] $Name
    )

    $Asset = Get-ChildItem -LiteralPath $Root -Recurse -File |
        Where-Object { $_.Name -eq $Name } |
        Sort-Object FullName |
        Select-Object -First 1
    if ($null -eq $Asset) {
        throw "Missing required release asset '$Name' under: $Root"
    }
    $Asset
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
if (-not $PSBoundParameters.ContainsKey("Prerelease") -and $Version -match "-") {
    $Prerelease = $true
}
if (-not $Target) {
    Push-Location $RepoRoot
    try {
        $Target = (& git rev-parse HEAD).Trim()
    } finally {
        Pop-Location
    }
}

$WindowsInstaller = Get-ReleaseAssetByName $AssetsRoot "WinSTT.exe"
$WindowsPortableZip = Get-ReleaseAssetByName $AssetsRoot "WinSTT-portable.zip"

$Assets = @($WindowsInstaller, $WindowsPortableZip)

$WindowsSignature = Get-ChildItem -LiteralPath $AssetsRoot -Recurse -File -Filter "*.exe.sig" |
    Sort-Object FullName |
    Select-Object -First 1
if ($null -ne $WindowsSignature) {
    $Assets += $WindowsSignature
} else {
    Write-Warning "Missing Windows updater signature (*.exe.sig) under: $AssetsRoot; latest.json will not be generated."
}

$LinuxAssets = @(
    Get-ChildItem -LiteralPath $AssetsRoot -Recurse -File |
        Where-Object { $_.Name.EndsWith(".AppImage") -or $_.Name.EndsWith(".AppImage.sig") -or $_.Extension -in @(".deb", ".rpm") } |
        Sort-Object FullName
)

if ($LinuxAssets.Count -eq 0) {
    throw "Missing Linux release assets under: $AssetsRoot"
}
$Assets += $LinuxAssets

$LinuxAppImage = $LinuxAssets |
    Where-Object { $_.Name.EndsWith(".AppImage") } |
    Select-Object -First 1
if ($null -eq $LinuxAppImage) {
    throw "Missing Linux AppImage updater asset under: $AssetsRoot"
}
$LinuxSignaturePath = "$($LinuxAppImage.FullName).sig"
$LinuxSignature = $null
if (Test-Path -LiteralPath $LinuxSignaturePath) {
    $LinuxSignature = Get-Item -LiteralPath $LinuxSignaturePath
} else {
    Write-Warning "Missing Linux AppImage updater signature: $LinuxSignaturePath; latest.json will not be generated."
}

if ($null -ne $WindowsSignature -and $null -ne $LinuxSignature) {
    $LatestJson = Join-Path $AssetsRoot "latest.json"
    $Manifest = New-UpdaterManifest `
        -Repository $Repository `
        -Tag $Tag `
        -Version $Version `
        -Notes $Notes `
        -WindowsAsset $WindowsInstaller `
        -WindowsSignature $WindowsSignature `
        -LinuxAppImage $LinuxAppImage `
        -LinuxSignature $LinuxSignature
    $Manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $LatestJson -Encoding utf8
    $Assets += Get-Item -LiteralPath $LatestJson
}
$Assets = @($Assets | Sort-Object FullName -Unique)

if ($DryRun) {
    Write-Host "Dry run: would upload release assets to ${Tag} (draft=$Draft prerelease=$Prerelease):"
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
    $EditArgs = @(
        "release", "edit", $Tag,
        "--title", $Title,
        "--notes", $Notes,
        "--draft=$($Draft.ToString().ToLowerInvariant())",
        "--prerelease=$($Prerelease.ToString().ToLowerInvariant())"
    )
    if (-not $Draft -and -not $Prerelease) {
        $EditArgs += "--latest"
    }
    Invoke-Gh @EditArgs
} else {
    $CreateArgs = @("release", "create", $Tag, "--target", $Target, "--title", $Title, "--notes", $Notes)
    if ($Draft) {
        $CreateArgs += "--draft"
    }
    if ($Prerelease) {
        $CreateArgs += "--prerelease"
        $CreateArgs += "--latest=false"
    } elseif (-not $Draft) {
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

param(
    [string] $PortableZip = "dist\WinSTT-portable.zip",
    [string] $Installer = "dist\WinSTT.exe"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $ScriptDir "..\.."))

function Resolve-RepoPath([string] $Path) {
    if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
    return [IO.Path]::GetFullPath((Join-Path $RepoRoot $Path))
}

function Assert-File([string] $Path, [string] $Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing $Label`: $Path" }
    if ((Get-Item -LiteralPath $Path).Length -eq 0) { throw "$Label is empty: $Path" }
}

function Assert-Directory([string] $Path, [string] $Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "Missing $Label`: $Path" }
}

function Assert-PeFile([string] $Path, [string] $Label) {
    Assert-File $Path $Label
    $stream = [IO.File]::OpenRead($Path)
    try {
        if ($stream.ReadByte() -ne 0x4D -or $stream.ReadByte() -ne 0x5A) {
            throw "$Label is not a Windows PE file: $Path"
        }
    }
    finally { $stream.Dispose() }
}

function Invoke-HeadlessSmoke([string] $Exe, [string] $Label) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Exe
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.ArgumentList.Add("--list-models")
    $start.ArgumentList.Add("--json")
    $process = [Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw "Could not start $Label headless smoke" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(60000)) {
        $process.Kill($true)
        $process.WaitForExit()
        throw "$Label headless smoke timed out after 60 seconds"
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
    $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
    if ($process.ExitCode -ne 0) {
        throw "$Label headless smoke failed ($($process.ExitCode)): $stderr"
    }
    if (-not $stdout) { throw "$Label headless smoke returned empty stdout" }
    try { $null = $stdout | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "$Label headless smoke did not return valid JSON: $stdout" }
    Write-Host "OK: $Label --list-models --json"
}

function Assert-PackageTree([string] $Root, [string] $Label) {
    $exe = Join-Path $Root "WinSTT.exe"
    Assert-PeFile $exe "$Label executable"
    Assert-PeFile (Join-Path $Root "winstt_context.exe") "$Label context sidecar"
    Assert-File (Join-Path $Root "portable") "$Label portable marker"
    Assert-Directory (Join-Path $Root "Data") "$Label isolated data directory"

    foreach ($relative in @(
        "resources\recording_sound_default.wav",
        "resources\error_sound.wav",
        "resources\marimba_start.wav",
        "resources\recording.png",
        "resources\tray_idle.png",
        "resources\models\silero_vad_v4.onnx",
        "resources\models\gigaam_vocab.txt",
        "DirectML.dll",
        "msvcp140.dll",
        "msvcp140_1.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll"
    )) {
        Assert-File (Join-Path $Root $relative) "$Label content '$relative'"
    }

    foreach ($dll in @("DirectML.dll", "msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll")) {
        Assert-PeFile (Join-Path $Root $dll) "$Label runtime '$dll'"
    }

    Invoke-HeadlessSmoke $exe $Label
}

$portableZipPath = Resolve-RepoPath $PortableZip
$installerPath = Resolve-RepoPath $Installer
Assert-File $portableZipPath "portable ZIP"
Assert-File $installerPath "NSIS executable"

$auditBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$auditRoot = Join-Path $auditBase ("winstt-package-audit-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $auditRoot | Out-Null

try {
    $zipRoot = Join-Path $auditRoot "portable-zip"
    Expand-Archive -LiteralPath $portableZipPath -DestinationPath $zipRoot
    $zipExe = @(Get-ChildItem -LiteralPath $zipRoot -Filter "WinSTT.exe" -File -Recurse)
    if ($zipExe.Count -ne 1) {
        throw "Portable ZIP must contain exactly one WinSTT.exe; found $($zipExe.Count)"
    }
    Assert-PackageTree $zipExe[0].DirectoryName "portable ZIP"

    $nsisRoot = Join-Path $auditRoot "nsis"
    New-Item -ItemType Directory -Path $nsisRoot | Out-Null
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $installerPath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.ArgumentList.Add("/S")
    $start.ArgumentList.Add("/PORTABLE")
    # NSIS requires /D= to be the final argument.
    $start.ArgumentList.Add("/D=$nsisRoot")
    $installerProcess = [Diagnostics.Process]::Start($start)
    if ($null -eq $installerProcess) { throw "Could not start NSIS package" }
    if (-not $installerProcess.WaitForExit(120000)) {
        $installerProcess.Kill($true)
        $installerProcess.WaitForExit()
        throw "NSIS package extraction timed out after 120 seconds"
    }
    if ($installerProcess.ExitCode -ne 0) {
        throw "NSIS package failed with exit code $($installerProcess.ExitCode)"
    }
    Assert-PackageTree $nsisRoot "NSIS package"
    Write-Host "Windows package audit passed."
}
finally {
    $candidate = [IO.Path]::GetFullPath($auditRoot)
    $requiredPrefix = $auditBase.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetFileName($candidate)).StartsWith("winstt-package-audit-", [StringComparison]::Ordinal)) {
        throw "Refusing to clean unexpected package-audit path: $candidate"
    }
    if (Test-Path -LiteralPath $candidate) {
        Remove-Item -LiteralPath $candidate -Recurse -Force
    }
}

<#
.SYNOPSIS
  Stand up a SECOND, CDP-enabled Chrome instance from a copy of the user's
  logged-in profile, so an automation harness can drive it over the DevTools
  Protocol without disturbing the user's primary Chrome.

  Chrome 136+ refuses --remote-debugging-port on the DEFAULT user-data-dir, so we
  copy the auth-critical profile pieces (Local State key, Cookies, Local Storage,
  IndexedDB, Preferences) into a private dir and launch Chrome there with a
  non-default --user-data-dir (where the debug port IS honored). Same machine,
  user and Chrome install means App-Bound Encryption still decrypts, so sessions
  stay logged in.

  Flow: close Chrome, fast selective copy, relaunch the user's normal Chrome,
  launch the CDP capture instance, probe http://127.0.0.1:PORT/json/version.

  The capture profile holds private cookies. It lives under artifacts/ (gitignored)
  and chrome-cdp-teardown.ps1 removes it.
#>
param(
    [int]$Port = 9222,
    [string]$ProfileDir = "E:\DL\Projects\WinSTT\artifacts\chrome-cdp-profile",
    [switch]$SkipCopy,
    [switch]$Minimized
)

$ErrorActionPreference = "Stop"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$srcUD = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
$srcDef = Join-Path $srcUD "Default"
$dstUD = Join-Path $ProfileDir "User Data"
$dstDef = Join-Path $dstUD "Default"

function Log([string]$m) { Write-Output ("[cdp-setup] " + $m) }

if (-not (Test-Path $chrome)) { throw "chrome.exe not found at $chrome" }

if (-not $SkipCopy) {
    Log "Closing all Chrome processes for a clean profile copy..."
    Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3

    Log "Preparing capture profile dir: $dstDef"
    if (Test-Path $dstUD) { Remove-Item -LiteralPath $dstUD -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $dstDef -Force | Out-Null

    foreach ($f in @("Local State", "First Run")) {
        $p = Join-Path $srcUD $f
        if (Test-Path $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $dstUD $f) -Force -ErrorAction SilentlyContinue }
    }
    foreach ($f in @("Preferences", "Secure Preferences", "Login Data", "Login Data For Account", "Web Data")) {
        $p = Join-Path $srcDef $f
        if (Test-Path $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $dstDef $f) -Force -ErrorAction SilentlyContinue }
    }

    $copyDirs = @("Network", "Local Storage", "IndexedDB", "Sessions", "Session Storage")
    foreach ($d in $copyDirs) {
        $s = Join-Path $srcDef $d
        if (Test-Path $s) {
            Log ("  copy " + $d + " ...")
            robocopy $s (Join-Path $dstDef $d) /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
        }
    }

    Log "Relaunching the user's primary Chrome (default profile, restoring tabs)..."
    Start-Process -FilePath $chrome -ArgumentList "--restore-last-session"
    Start-Sleep -Seconds 2
}

Log ("Launching CDP capture instance on port " + $Port + " from " + $dstUD + " ...")
$launchArgs = @(
    "--user-data-dir=$dstUD",
    "--remote-debugging-port=$Port",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--window-position=-2400,-2400",
    "--window-size=1300,900",
    "about:blank"
)
if ($Minimized) { $launchArgs += "--start-minimized" }
Start-Process -FilePath $chrome -ArgumentList $launchArgs

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-RestMethod -Uri ("http://127.0.0.1:$Port/json/version") -TimeoutSec 2 -ErrorAction Stop
        Log ("CDP OK: " + $r.Browser)
        Log ("webSocketDebuggerUrl present: " + [bool]$r.webSocketDebuggerUrl)
        $ok = $true; break
    } catch { }
}
if (-not $ok) {
    Log ("CDP STILL NOT REACHABLE on " + $Port + " - capture instance failed to expose the port.")
    exit 3
}
Log "READY"

<#
  Ensure the dedicated CDP capture Chrome is ALIVE on -Port, relaunching it from
  the EXISTING profile if it died, WITHOUT ever copying or wiping the profile
  (copying/wiping is what logs the apps out). Safe to call before every run.

  - If CDP already responds: prints ALIVE and exits 0 (fast no-op).
  - If dead: force-kills only ORPHAN capture-profile chrome procs (no main window,
    so no unflushed session to lose), relaunches from the existing UserData with
    the debug port + occlusion-off flags, waits for CDP, prints RELAUNCHED.
  - Never touches the user main Chrome (matched strictly by the capture profile path).
#>
param(
    [int]$Port = 9222,
    [string]$ProfileDir = "E:\DL\Projects\WinSTT\artifacts\chrome-cdp-profile"
)
$ErrorActionPreference = "Stop"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ud = Join-Path $ProfileDir "UserData"

function CdpAlive {
    try { $null = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 -ErrorAction Stop; return $true }
    catch { return $false }
}

if (CdpAlive) { Write-Output "ALIVE"; exit 0 }

$cookies = Join-Path $ud "Default\Network\Cookies"
if (-not (Test-Path $cookies)) {
    Write-Output "PROFILE_MISSING: no cookies at $cookies - needs one-time setup + login"
    exit 2
}

# Clean up orphan capture-profile processes (renderers left after a browser crash).
# They hold no session state, so force-stopping them cannot log anything out.
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -match [regex]::Escape("chrome-cdp-profile") } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Start-Process -FilePath $chrome -ArgumentList @(
    "--user-data-dir=$ud",
    "--remote-debugging-port=$Port",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--restore-last-session",
    # Eagerly build the FULL renderer accessibility tree so the native UIA read
    # (winstt_context.exe --tree --hwnd) can resolve the DOM-focused composer as
    # the focused UIA element. Without this Chrome lazily exposes only a shallow
    # web tree + the browser frame, so the focused element resolves to the window
    # ROOT (elementName == window title, focusedFieldLooksComposer=false) even
    # when the window is foregrounded and the composer holds DOM focus.
    "--force-renderer-accessibility",
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--window-position=-2400,-2400",
    "--window-size=1300,900",
    "about:blank"
)

for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 1
    if (CdpAlive) { Write-Output "RELAUNCHED"; exit 0 }
}
Write-Output "FAILED: relaunched but CDP not reachable on $Port"
exit 3

<#
.SYNOPSIS
  Resolve the decimal HWND of the first visible chrome.exe top-level window whose
  title contains -TitleLike (case-insensitive substring). Prints the decimal HWND
  on success, or "NO_MATCH" if none matched.

  Occlusion-proof: enumerates ALL visible top-level windows via EnumWindows (not
  just MainWindowHandle), so it finds a specific Chrome window even when it is not
  in the foreground. Used by tools/context-cdp-capture.mjs to target the exact
  Chrome window the harness navigated, then passed to winstt_context.exe --hwnd.

  Recreated to replace the deleted examples/.../resolve-hwnd.ps1; the EnumWindows
  P/Invoke is copied from tools/windows/context-capture-window.ps1.

.EXAMPLE
  pwsh tools/windows/resolve-hwnd.ps1 -TitleLike 'Gmail'
#>
param(
    [Parameter(Mandatory = $true)][string]$TitleLike,
    [string]$ExeMatch = "chrome"
)

$ErrorActionPreference = "Stop"

$pinvoke = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static List<object[]> List() {
    var rows = new List<object[]>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      rows.Add(new object[] { h.ToInt64(), sb.ToString(), pid });
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@
Add-Type -TypeDefinition $pinvoke | Out-Null

foreach ($row in [WinEnum]::List()) {
    $hwnd = [int64]$row[0]
    $title = [string]$row[1]
    $procId = [uint32]$row[2]
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { "" }
    if ([string]::IsNullOrEmpty($title)) { continue }
    if ($title.IndexOf($TitleLike, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    if (-not [string]::IsNullOrWhiteSpace($ExeMatch) -and $procName -notmatch $ExeMatch) { continue }
    Write-Output $hwnd
    exit 0
}

Write-Output "NO_MATCH"
exit 0

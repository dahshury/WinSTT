# Resolve a Chrome window's HWND (decimal) by matching its title, restricted to
# the chrome.exe process. EnumWindows ignores z-order, so this finds the window
# even when it's OCCLUDED behind the IDE/terminal (WindowFromPoint can't —  it
# returns the topmost window at a pixel, which is whatever's in front). The
# context-harness uses this so winstt-context.exe --hwnd reads the right Chrome
# window with NO OS-foreground forcing.
#
# Match is case-insensitive substring on the window title, chrome.exe only.
# Prints the decimal HWND of the first match, or "NO_MATCH". Exit 0 always.
param([Parameter(Mandatory = $true)][string]$TitleLike)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class HwndResolve {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint procId);
  public static string TitleOf(IntPtr h) {
    int len = GetWindowTextLength(h);
    if (len == 0) return "";
    StringBuilder sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
}
"@

# Build the set of chrome.exe PIDs once (so we don't match an IDE window that
# happens to contain the same title text, e.g. an editor showing this file).
$chromePids = @{}
foreach ($pr in (Get-Process chrome -ErrorAction SilentlyContinue)) { $chromePids[[uint32]$pr.Id] = $true }

$targetLower = $TitleLike.ToLowerInvariant()
$found = [IntPtr]::Zero
$cb = [HwndResolve+EnumWindowsProc] {
  param($h, $l)
  if (-not [HwndResolve]::IsWindowVisible($h)) { return $true }
  $wpid = [uint32]0
  [void][HwndResolve]::GetWindowThreadProcessId($h, [ref]$wpid)
  if (-not $script:chromePids.ContainsKey($wpid)) { return $true }
  $t = [HwndResolve]::TitleOf($h)
  if ($t -and $t.ToLowerInvariant().Contains($script:targetLower)) {
    $script:found = $h
    return $false # first chrome window whose title matches
  }
  return $true
}
[void][HwndResolve]::EnumWindows($cb, [IntPtr]::Zero)

if ($found -eq [IntPtr]::Zero) {
  Write-Output "NO_MATCH"
} else {
  Write-Output ([Int64]$found).ToString()
}
exit 0

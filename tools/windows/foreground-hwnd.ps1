<#
.SYNOPSIS
  Make a specific (normally OFF-SCREEN) Chrome capture window the genuine OS-foreground
  window with its web COMPOSER focused, so the native UIA read resolves the focused
  composer instead of the window ROOT — then restore the window + prior foreground so
  the user is minimally disturbed.

  Why this exists: tools/context-cdp-capture.mjs navigates + DOM-focuses a composer in a
  Chrome window parked at -2400,-2400 that is NOT the OS-foreground window. When
  winstt_context.exe --tree --hwnd <hwnd> reads it, UIA resolves the focused element to
  the window ROOT (elementName == window title, focusedFieldLooksComposer=false): a
  backgrounded window's web render widget never held OS keyboard focus, so the DOM-focused
  composer is NOT marked HasKeyboardFocus in the UIA tree.

  Empirically, synthetic focus moves (SetForegroundWindow, child SetFocus, CDP input,
  WM_MOUSEACTIVATE) bring the window forward but do NOT move Chrome's VIEW focus into the
  web content — UIA keeps reporting the window/toolbar. The only thing that does is a REAL
  OS mouse click delivered into the page (mouse_event/SendInput at screen coords). So this
  helper briefly moves the window on-screen, foregrounds it, performs a genuine click at
  the composer's client coordinates, lets the harness do the UIA read, then the -Restore
  call moves the window back off-screen and re-foregrounds the prior window. The window is
  on-screen only for the few hundred ms of the read.

  Windows blocks SetForegroundWindow from a background process; the AttachThreadInput +
  synthetic-ALT workaround clears the foreground lock.

.PARAMETER Hwnd
  Decimal HWND of the capture window to foreground + click.

.PARAMETER ClickX / ClickY
  Composer center in CSS px relative to the page viewport (== render-widget client coords).
  When >= 0, a real OS click is delivered there to move Chrome's view focus into the composer.

.PARAMETER Restore
  Decimal prior-foreground HWND to re-foreground (the second, post-read call). With it,
  -Hwnd is the capture window to move back off-screen and -OrigX/-OrigY its original position.

.PARAMETER OrigX / OrigY
  Original (off-screen) top-left of the capture window, to restore on the -Restore call.

.OUTPUTS
  Foreground call: prints "prior|origX|origY" (decimal). prior=0 when none.
  -Restore call:   prints "RESTORED" (or "RESTORE_NOOP").
#>
param(
    [long]$Hwnd = 0,
    [int]$ClickX = -1,
    [int]$ClickY = -1,
    [double]$ClickFx = -1,
    [double]$ClickFy = -1,
    [long]$Restore = -1,
    [int]$OrigX = -999999,
    [int]$OrigY = -999999
)

$ErrorActionPreference = "Stop"

$pinvoke = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

  const int SW_RESTORE = 9;
  const byte VK_MENU = 0x12;            // ALT
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint SWP_NOSIZE = 0x0001, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const string RenderWidgetClass = "Chrome_RenderWidgetHostHWND";

  // Original top-left of the capture window (so the harness can restore it).
  public static int OrigLeft, OrigTop;
  // Diagnostics.
  public static string LastClick = "";

  // Lift the foreground lock + bring hWnd forward (works from a background process).
  // sendAlt=false skips the synthetic ALT tap: a stray ALT keystroke can be consumed
  // by the web app (e.g. Claude's ProseMirror) and disturb composer focus right before
  // the click, so the on-screen click path foregrounds without it (the window is being
  // shown on-screen anyway, which already satisfies the foreground change).
  static void Foreground(IntPtr hWnd, bool sendAlt = true) {
    if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
    if (sendAlt) {
      keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
      keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
    uint pid; uint tt = GetWindowThreadProcessId(hWnd, out pid);
    uint ct = GetCurrentThreadId();
    bool att = (tt != ct) && AttachThreadInput(ct, tt, true);
    try { BringWindowToTop(hWnd); if (!SetForegroundWindow(hWnd)) { ShowWindow(hWnd, SW_RESTORE); SetForegroundWindow(hWnd); } }
    finally { if (att) AttachThreadInput(ct, tt, false); }
  }

  // Largest visible page render widget (the smaller siblings are popups / UI surfaces).
  static IntPtr FindRenderWidget(IntPtr parent) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumChildWindows(parent, (h, l) => {
      var sb = new StringBuilder(128); GetClassName(h, sb, sb.Capacity);
      if (sb.ToString() == RenderWidgetClass && IsWindowVisible(h)) {
        RECT r; if (GetWindowRect(h, out r)) {
          long a = (long)Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top);
          if (a > bestArea) { bestArea = a; best = h; }
        }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  // Move the window on-screen, foreground it, and deliver a GENUINE OS left-click at the
  // composer's location inside the page render widget. This is the only move that pushes
  // Chrome's view focus into the web content so the DOM-focused composer becomes the UIA
  // focused element. The click point is given as FRACTIONS (fx,fy in 0..1) of the render
  // widget's REAL client rect (robust to any CDP-viewport-vs-window-size mismatch); a
  // negative fraction falls back to the absolute client px (clientX/clientY). Returns
  // true on a delivered click.
  public static bool ForegroundAndClick(IntPtr hWnd, int clientX, int clientY, double fx, double fy) {
    if (!IsWindow(hWnd)) { LastClick = "no-window"; return false; }
    RECT wr; GetWindowRect(hWnd, out wr);
    OrigLeft = wr.Left; OrigTop = wr.Top;

    // Slide on-screen to a fixed top-left (keep size) so the click coords are on the desktop.
    // Foreground DIRECTLY (BringWindowToTop + SetForegroundWindow) without AttachThreadInput
    // or the ALT tap: attaching our input thread to Chrome's around the synthetic click is
    // what was suppressing the click from reaching the renderer (verified — the same coords
    // land the composer when foregrounded this way).
    SetWindowPos(hWnd, IntPtr.Zero, 100, 100, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW);
    BringWindowToTop(hWnd);
    if (!SetForegroundWindow(hWnd)) { ShowWindow(hWnd, SW_RESTORE); SetForegroundWindow(hWnd); }

    bool haveFrac = fx >= 0 && fy >= 0;
    if (!haveFrac && (clientX < 0 || clientY < 0)) { LastClick = "no-coords"; return false; }
    IntPtr rw = FindRenderWidget(hWnd);
    if (rw == IntPtr.Zero) { LastClick = "no-render-widget"; return false; }

    int cx, cy;
    if (haveFrac) {
      RECT cr; GetWindowRect(rw, out cr);
      int rww = Math.Max(1, cr.Right - cr.Left);
      int rwh = Math.Max(1, cr.Bottom - cr.Top);
      cx = (int)Math.Round(fx * rww);
      cy = (int)Math.Round(fy * rwh);
      cx = Math.Max(2, Math.Min(rww - 2, cx));
      cy = Math.Max(2, Math.Min(rwh - 2, cy));
    } else { cx = clientX; cy = clientY; }

    POINT pt; pt.X = cx; pt.Y = cy; ClientToScreen(rw, ref pt);
    SetCursorPos(pt.X, pt.Y);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(45);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    LastClick = "click@" + pt.X + "," + pt.Y + " client=" + cx + "," + cy + (haveFrac ? " (frac)" : "");
    return true;
  }

  // Move the capture window back to its original (off-screen) position, then re-foreground
  // the window that was foreground before the read.
  public static void RestoreWindow(IntPtr capture, int origX, int origY, IntPtr prior) {
    if (IsWindow(capture)) {
      SetWindowPos(capture, IntPtr.Zero, origX, origY, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
    if (prior != IntPtr.Zero && IsWindow(prior)) Foreground(prior);
  }
}
'@
Add-Type -TypeDefinition $pinvoke | Out-Null

if ($Restore -ge 0) {
    # Restore: move the capture window (-Hwnd) back off-screen (-OrigX/-OrigY) and
    # re-foreground the prior window (-Restore).
    $capture = if ($Hwnd -gt 0) { [IntPtr]$Hwnd } else { [IntPtr]::Zero }
    $prior = if ($Restore -gt 0) { [IntPtr]$Restore } else { [IntPtr]::Zero }
    if ($capture -eq [IntPtr]::Zero -and $prior -eq [IntPtr]::Zero) { Write-Output "RESTORE_NOOP"; exit 0 }
    $ox = if ($OrigX -gt -999999) { $OrigX } else { -2400 }
    $oy = if ($OrigY -gt -999999) { $OrigY } else { -2400 }
    [Fg]::RestoreWindow($capture, $ox, $oy, $prior)
    Write-Output "RESTORED"
    exit 0
}

if ($Hwnd -le 0) { Write-Output "0|-2400|-2400"; exit 0 }

# Capture the prior foreground window so the caller can restore it after the read.
$prior = [Fg]::GetForegroundWindow().ToInt64()
$null = [Fg]::ForegroundAndClick([IntPtr]$Hwnd, $ClickX, $ClickY, $ClickFx, $ClickFy)
$origX = [Fg]::OrigLeft
$origY = [Fg]::OrigTop
[Console]::Error.WriteLine("foreground: target=$Hwnd prior=$prior orig=$origX,$origY click=$([Fg]::LastClick)")
if ($env:FG_DEBUG_LOG) { Add-Content -Path $env:FG_DEBUG_LOG -Value "foreground target=$Hwnd prior=$prior orig=$origX,$origY click=$([Fg]::LastClick)" }
# Print "prior|origX|origY" so the restore call can fully restore window + foreground.
Write-Output ("{0}|{1}|{2}" -f $prior, $origX, $origY)
exit 0

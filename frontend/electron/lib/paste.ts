import { execFile } from "node:child_process";
import { clipboard } from "electron";

/**
 * PowerShell script that calls user32.dll keybd_event to:
 * 1. Release all modifier keys (safety — mirrors pyautogui.keyUp in hotkeys_demo.py)
 * 2. Simulate Ctrl+V
 *
 * Virtual-key codes: https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes
 *   0xA0–0xA5 = L/R Shift, Ctrl, Alt
 *   0x11 = VK_CONTROL, 0x56 = VK_V
 *   dwFlags 2 = KEYEVENTF_KEYUP
 */
const PS_CTRL_V = `\
$sig='[DllImport("user32.dll")]public static extern void keybd_event(byte bVk,byte bScan,uint dwFlags,UIntPtr dwExtraInfo);'
$t=Add-Type -MemberDefinition $sig -Name KB -Namespace Win32 -PassThru
$U=[uint32]2;$Z=[UIntPtr]::Zero
$t::keybd_event(0xA2,0,$U,$Z)
$t::keybd_event(0xA3,0,$U,$Z)
$t::keybd_event(0xA0,0,$U,$Z)
$t::keybd_event(0xA1,0,$U,$Z)
$t::keybd_event(0xA4,0,$U,$Z)
$t::keybd_event(0xA5,0,$U,$Z)
$t::keybd_event(0x11,0,0,$Z)
$t::keybd_event(0x56,0,0,$Z)
$t::keybd_event(0x56,0,$U,$Z)
$t::keybd_event(0x11,0,$U,$Z)`;

/**
 * Copy text to clipboard and simulate Ctrl+V into the currently focused window.
 * Mirrors hotkeys_demo.py: `pyperclip.copy(text) + pyautogui.hotkey("ctrl", "v")`
 */
export function pasteText(text: string): void {
	if (!text) {
		return;
	}
	clipboard.writeText(text);
	execFile(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", PS_CTRL_V],
		{ windowsHide: true },
		(error) => {
			if (error) {
				console.error("[paste] Failed to simulate Ctrl+V:", error.message);
			}
		},
	);
}

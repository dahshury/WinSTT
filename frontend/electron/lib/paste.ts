import { execFile } from "node:child_process";
import { clipboard } from "electron";
import { setPasteGuard } from "../ipc/hotkey";

/**
 * PowerShell script that calls user32.dll to:
 * 1. Release all modifier keys (including Win) so they don't combine with Ctrl+V
 * 2. Simulate Ctrl+V
 *
 * Modifiers are NOT re-pressed — the paste guard in hotkey.ts still tracks
 * physical key releases in pressedKeys, and fires a deferred hotkey:released
 * when the guard lifts if the combo keys were released during the guard window.
 *
 * Virtual-key codes: https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes
 *   0xA0–0xA5 = L/R Shift, Ctrl, Alt; 0x5B–0x5C = L/R Win
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
$t::keybd_event(0x5B,0,$U,$Z)
$t::keybd_event(0x5C,0,$U,$Z)
$t::keybd_event(0x11,0,0,$Z)
$t::keybd_event(0x56,0,0,$Z)
$t::keybd_event(0x56,0,$U,$Z)
$t::keybd_event(0x11,0,$U,$Z)`;

/**
 * Copy text to clipboard and simulate Ctrl+V into the currently focused window.
 * Mirrors hotkeys_demo.py: `pyperclip.copy(text) + pyautogui.hotkey("ctrl", "v")`
 *
 * Activates a paste guard so the uiohook-based hotkey handler ignores
 * the synthetic modifier release events during the paste.
 */
export function pasteText(text: string): void {
	if (!text) {
		return;
	}
	if (process.platform !== "win32") {
		return;
	}
	clipboard.writeText(text);
	setPasteGuard(true);
	execFile(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", PS_CTRL_V],
		{ windowsHide: true },
		(error) => {
			setPasteGuard(false);
			if (error) {
				console.error("[paste] Failed to simulate Ctrl+V:", error.message);
			}
		}
	);
}

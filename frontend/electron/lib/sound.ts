import { execFile } from "node:child_process";
import path from "node:path";
import { store } from "./store";

const DEFAULT_SOUND_PATH = path.join(import.meta.dirname, "..", "build", "splash.wav");

/**
 * Play an audio file (WAV or MP3) using PowerShell.
 * - WAV: uses Media.SoundPlayer.PlaySync() (fast, lightweight)
 * - MP3: uses Windows Media Player COM object (supports all common formats)
 */
export function playSound(filePath: string): void {
	const escaped = filePath.replace(/'/g, "''");
	const isWav = filePath.toLowerCase().endsWith(".wav");

	// Media.SoundPlayer only supports WAV. For MP3 use WMP COM.
	const command = isWav
		? `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`
		: `$p = New-Object -ComObject WMPlayer.OCX; $p.URL = '${escaped}'; $p.controls.play(); Start-Sleep -Milliseconds 3500; $p.close()`;

	execFile(
		"powershell",
		["-NoProfile", "-NonInteractive", "-Command", command],
		{ windowsHide: true },
		(err) => {
			if (err) {
				console.warn("[sound] Failed to play:", err.message);
			}
		}
	);
}

/** Play the recording-start sound if enabled in settings. */
export function playRecordingSound(): void {
	const enabled = store.get("general.recordingSound") as boolean | undefined;
	if (enabled === false) {
		return;
	}
	const customPath = store.get("general.recordingSoundPath") as string | undefined;
	const soundPath = customPath && customPath.length > 0 ? customPath : DEFAULT_SOUND_PATH;
	playSound(soundPath);
}

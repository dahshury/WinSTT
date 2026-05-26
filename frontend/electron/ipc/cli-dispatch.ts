import type { BrowserWindow } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import type { CliArgs } from "../lib/cli-args";
import { dbg } from "../lib/debug-log";
import { notifyHotkeyPressed, notifyRecordingStop } from "../lib/recording-state";
import type { SttClient } from "../ws/stt-client";
import { handleAbortOperation } from "./stt-commands";

/**
 * Dispatch the runtime action flags from a CLI invocation (either the
 * very first launch or a `--toggle-transcription` from a second instance
 * that we collapsed into the running app via single-instance lock).
 *
 * Action flags are mutually exclusive in spirit but cheap to evaluate
 * independently — we just dispatch each one that's set. `--help` is
 * filtered out earlier (the parent prints help and exits before reaching
 * this code), so this only sees the runtime actions.
 *
 * Resolution:
 *
 *   --toggle-transcription
 *     Same path the real global hotkey takes:
 *       1. `notifyHotkeyPressed()` flips the PTT-intent flag or the
 *          toggle-session flag depending on `general.recordingMode`,
 *          authorising the next `recording_start` from the server.
 *       2. Emit `IPC.HOTKEY_PRESSED` to the main window's webContents
 *          so the renderer's `usePushToTalk` hook calls
 *          `set_microphone(true)` (toggle-ON / PTT-start).
 *       3. Schedule `IPC.HOTKEY_RELEASED` on the next tick so the
 *          renderer also runs its release-side cleanup (PTT-stop,
 *          listen-mode no-op, etc.). For toggle mode this is harmless
 *          (release in toggle is intentionally a no-op in the hook).
 *
 *   --cancel
 *     Same handler the UI cancel button + hotkey+Backspace combo use.
 *     Five-step cleanup: abort-state flag, Ollama chats, server abort,
 *     hide overlay, plus a `notifyRecordingStop()` to clear any
 *     pending PTT intent we just leaked above (defensive).
 */
export function dispatchCliActions(
	args: CliArgs,
	sttClient: SttClient,
	mainWindow: BrowserWindow | null
): void {
	if (args.toggleTranscription) {
		dispatchToggleTranscription(mainWindow);
	}
	if (args.cancel) {
		dispatchCancel(sttClient);
	}
}

function dispatchToggleTranscription(mainWindow: BrowserWindow | null): void {
	dbg("cli", "toggle-transcription action");
	notifyHotkeyPressed();
	const target = mainWindow?.webContents;
	if (!target || target.isDestroyed()) {
		dbg("cli", "toggle-transcription: no live main window — recording-state flipped only");
		return;
	}
	target.send(IPC.HOTKEY_PRESSED);
	// Schedule release on the next tick so the renderer's pressed
	// handler runs first. setImmediate is preferred over a 0ms timeout
	// because it sits on the macrotask queue right after I/O, which is
	// where the IPC send lands.
	setImmediate(() => {
		if (!mainWindow || mainWindow.isDestroyed()) {
			return;
		}
		mainWindow.webContents.send(IPC.HOTKEY_RELEASED);
	});
}

function dispatchCancel(sttClient: SttClient): void {
	dbg("cli", "cancel action");
	// Clear any pending PTT intent first so the abort doesn't leave the
	// state machine thinking a fresh recording is about to start.
	notifyRecordingStop();
	handleAbortOperation(sttClient);
}

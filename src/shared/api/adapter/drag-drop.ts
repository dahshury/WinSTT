// ── getPathForFile drag-drop bridge (WU-8: file-transcription owns this) ─────────
// Tauri's webview does NOT expose native paths on the DOM `File` (security). The
// renderer's `getFilePath(file)` (used by the file-transcription drag-drop in
// `widgets/audio-display`) is SYNCHRONOUS — it must return the absolute path the
// instant the DOM `drop` handler runs `collectDroppedFiles`. So we cannot resolve
// the path inside an `await`; we have to have it ready *before* the DOM drop fires.
//
// Tauri v2's `onDragDropEvent` emits phases `enter → over… → drop → leave`, and
// BOTH `enter` and `drop` carry the absolute `paths`. The native `enter` fires
// before the DOM `drop` (the OS announces the dragged payload as it crosses the
// window before it's released), so populating `lastDropPaths` on `enter` makes
// `getPathForFile` resolve synchronously by the time `drop` is handled. We keep
// `drop` as a backstop (covers webviews/platforms where `enter` lacks paths) and
// keep the map keyed by name (+size when available) for collision safety.
//
// Extracted from native-bridge-adapter.ts (behavior-preserving move).

import { emitFileDragDropEvent } from "../file-drag-drop";

const lastDropPaths = new Map<string, string>();

function dropKey(name: string, size?: number): string {
	return size === undefined ? name : `${name}:${size}`;
}

function rememberDropPaths(paths: readonly string[]): void {
	for (const path of paths) {
		const name = path.split(/[\\/]/).pop();
		if (name) {
			// Key by bare name (the DOM File exposes name+size, never the path).
			lastDropPaths.set(name, path);
		}
	}
}

export function fileToTauriPath(file: File): string {
	return (
		lastDropPaths.get(dropKey(file.name, file.size)) ??
		lastDropPaths.get(file.name) ??
		""
	);
}

export async function wireDragDrop(): Promise<void> {
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		await getCurrentWindow().onDragDropEvent((event) => {
			const payload = event.payload;
			// `enter` AND `drop` carry `paths` in Tauri v2. Stash on BOTH: `enter`
			// (before the DOM drop) makes the synchronous `getFilePath` resolve;
			// `drop` is the backstop. `over`/`leave` carry no paths — ignore.
			if (payload.type === "enter" || payload.type === "drop") {
				rememberDropPaths(payload.paths);
			}
			emitFileDragDropEvent({
				type: payload.type,
				paths:
					payload.type === "enter" || payload.type === "drop"
						? [...payload.paths]
						: [],
			});
		});
	} catch {
		// Not in a Tauri window context — drag-drop bridge unavailable.
	}
}

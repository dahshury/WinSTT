import path from "node:path";
import { BrowserWindow, clipboard, ipcMain } from "electron";
import { getErrorMessage } from "../../src/shared/lib/errors";
import { setFileQueueBusy } from "../lib/file-transcribe-state";
import { createSafeSender } from "../lib/ipc-helpers";
import { onDictationActiveChange } from "../lib/recording-state";
import type { SttClient } from "../ws/stt-client";
import { type PendingRequest, type ResumeState, transcribeFile } from "./file-transcribe";

/**
 * Multi-file transcription queue (additive layer on top of {@link transcribeFile}).
 *
 * Files dropped on the main window transcribe SEQUENTIALLY — the shared STT
 * model is single-threaded. This module owns the queue, the per-file UI state,
 * and:
 *
 *  1. **Pump** — sends one `transcribe_file` at a time, advancing on the
 *     server's terminal events (complete / error / canceled).
 *  2. **Push-to-talk auto-pause** — pauses the WHOLE pump while the user dictates
 *     (the model is busy), parking the in-flight file and resuming after.
 *  3. **Per-row manual pause/resume** — a "paused" row is skipped by the pump, so
 *     a stopped file NEVER blocks newly-dropped ones; resume continues from where
 *     it stopped (the server hands back `resume_from` + finished chunks on cancel,
 *     which the next dispatch replays).
 *  4. **Busy flag** — published so the model-swap handler blocks swaps while busy.
 *
 * File WRITING (the `.txt` / `.srt`) + the save dialog stay in the base
 * `setupFileTranscribeHandlers` layer; this module is orchestration + UI.
 */

type QueueStatus = "queued" | "transcribing" | "complete" | "error" | "paused" | "canceled";

interface QueueItem {
	fileName: string;
	filePath: string;
	id: string;
	message: string;
	/** True when the USER manually paused this row (survives a PTT auto-resume). */
	pausedByUser?: boolean | undefined;
	/** Already-finished chunks (absolute timestamps) for resuming a paused row. */
	priorSegments?: [number, number, string][] | undefined;
	/** 0..1 */
	progress: number;
	/** The server request id, present only while sent/in-flight. */
	requestId?: string | undefined;
	/** Seconds into the file to resume from (0 = fresh start). */
	resumeFrom?: number | undefined;
	stage: string;
	status: QueueStatus;
	/** Filled on completion so the per-row Copy action can read it. */
	text?: string | undefined;
}

interface QueueItemDTO {
	fileName: string;
	id: string;
	message: string;
	progress: number;
	stage: string;
	status: QueueStatus;
}

interface EnqueuePayload {
	files?: { filePath?: string; fileName?: string }[];
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parsePartialSegments(value: unknown): [number, number, string][] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: [number, number, string][] = [];
	for (const seg of value) {
		if (Array.isArray(seg) && seg.length >= 3) {
			out.push([asNumber(seg[0], 0), asNumber(seg[1], 0), asString(seg[2])]);
		}
	}
	return out;
}

function toDTO(item: QueueItem): QueueItemDTO {
	return {
		id: item.id,
		fileName: item.fileName,
		status: item.status,
		progress: item.progress,
		stage: item.stage,
		message: item.message,
	};
}

function isBusyStatus(status: QueueStatus): boolean {
	return status === "queued" || status === "transcribing" || status === "paused";
}

function isTerminalStatus(status: QueueStatus): boolean {
	return status === "complete" || status === "error" || status === "canceled";
}

// Once the queue fully drains (every row terminal) the panel auto-clears after
// this delay, returning the main window to the visualizer without the user
// having to hit a button. Cancelled if new files are dropped meanwhile.
const AUTO_CLEAR_DELAY_MS = 2500;

export function setupFileTranscribeQueue(
	win: BrowserWindow,
	client: SttClient,
	pendingRequests: Map<string, PendingRequest>
): { cleanup: () => void } {
	const items: QueueItem[] = [];
	let activeRequestId: string | null = null;
	// Push-to-talk auto-pause: blocks the WHOLE pump (the shared model is busy
	// dictating). Manual pause is per-ROW (a "paused" status the pump skips), so
	// stopping one file never blocks newly-dropped files.
	let dictationPaused = false;
	// Why the in-flight cancel was requested, so the canceled event knows the
	// outcome: "dictation" → park (auto-resumes), "userPause" → park (manual
	// resume only), "userCancel" → drop the row.
	let pendingCancelReason: "dictation" | "userPause" | "userCancel" | null = null;
	let counter = 0;
	let lastBroadcastActive: boolean | null = null;
	let autoClearTimer: ReturnType<typeof setTimeout> | null = null;

	const safeSend = createSafeSender(win);

	function broadcastActive(active: boolean): void {
		// Cross-window: the detached model-picker disables selection while busy.
		// Only emit on transitions to avoid storming the channel.
		if (active === lastBroadcastActive) {
			return;
		}
		lastBroadcastActive = active;
		for (const w of BrowserWindow.getAllWindows()) {
			if (!w.isDestroyed()) {
				w.webContents.send("file:queue-active", { active });
			}
		}
	}

	function emitQueue(): void {
		safeSend("file:queue-update", { items: items.map(toDTO) });
		const busy = items.some((it) => isBusyStatus(it.status));
		setFileQueueBusy(busy);
		broadcastActive(busy);
		scheduleAutoClear(busy);
	}

	function autoClear(): void {
		autoClearTimer = null;
		// A drop during the delay could have re-added work — bail if so.
		if (items.some((it) => isBusyStatus(it.status))) {
			return;
		}
		clearFinished();
	}

	function scheduleAutoClear(busy: boolean): void {
		if (autoClearTimer) {
			clearTimeout(autoClearTimer);
			autoClearTimer = null;
		}
		// Auto-return to the visualizer once every row is terminal. "paused" counts
		// as busy, so a manually-stopped file keeps the panel up.
		if (!busy && items.length > 0) {
			autoClearTimer = setTimeout(autoClear, AUTO_CLEAR_DELAY_MS);
		}
	}

	function emitProgress(item: QueueItem): void {
		safeSend("file:queue-progress", {
			id: item.id,
			progress: item.progress,
			stage: item.stage,
		});
	}

	function findByRequestId(requestId: string): QueueItem | undefined {
		return items.find((it) => it.requestId === requestId);
	}

	function removeItem(id: string): void {
		const idx = items.findIndex((it) => it.id === id);
		if (idx >= 0) {
			items.splice(idx, 1);
		}
	}

	function resumeStateOf(item: QueueItem): ResumeState | undefined {
		if (
			item.resumeFrom !== undefined &&
			(item.resumeFrom > 0 || (item.priorSegments?.length ?? 0) > 0)
		) {
			return { resumeFrom: item.resumeFrom, priorSegments: item.priorSegments ?? [] };
		}
		return;
	}

	async function pump(): Promise<void> {
		if (dictationPaused || activeRequestId !== null || !client.isConnected) {
			return;
		}
		// Skips "paused" rows automatically (only "queued" runs).
		const next = items.find((it) => it.status === "queued");
		if (!next) {
			return;
		}
		next.status = "transcribing";
		// Keep a resumed row's frozen progress so the bar doesn't flash to 0; a
		// fresh file starts at 0.
		next.progress = next.resumeFrom ? next.progress : 0;
		next.stage = "starting";
		next.message = "";
		// Hold the slot with the local id so a second pump can't race in during the
		// await; replaced with the real server request id once sent.
		activeRequestId = next.id;
		emitQueue();
		try {
			const { requestId } = await transcribeFile(
				client,
				next.filePath,
				pendingRequests,
				resumeStateOf(next)
			);
			if (!requestId) {
				// Save dialog cancelled — skip this file and advance.
				next.status = "canceled";
				next.stage = "canceled";
				next.message = "Canceled";
				activeRequestId = null;
				emitQueue();
				schedulePump();
				return;
			}
			next.requestId = requestId;
			activeRequestId = requestId;
			// A pause/cancel requested during the dispatch await named the local id
			// the server never saw — re-issue now against the real request_id.
			if (pendingCancelReason) {
				client.sendControl({ command: "cancel_file_transcription", request_id: requestId });
			} else if (dictationPaused) {
				pendingCancelReason = "dictation";
				client.sendControl({ command: "cancel_file_transcription", request_id: requestId });
			}
			emitQueue();
		} catch (err) {
			next.status = "error";
			next.stage = "error";
			next.message = getErrorMessage(err);
			next.requestId = undefined;
			activeRequestId = null;
			emitQueue();
			schedulePump();
		}
	}

	function schedulePump(): void {
		pump().catch((err) => {
			console.error("[file-queue] pump failed:", getErrorMessage(err));
		});
	}

	function handleCanceledEvent(item: QueueItem, event: Record<string, unknown>): void {
		if (activeRequestId === item.requestId) {
			activeRequestId = null;
		}
		// The base layer's complete handler never fires for a cancelled request, so
		// its pendingRequests entry would leak — drop it here.
		if (item.requestId) {
			pendingRequests.delete(item.requestId);
		}
		item.requestId = undefined;
		const reason = pendingCancelReason;
		pendingCancelReason = null;
		if (reason === "userCancel") {
			removeItem(item.id);
		} else {
			// Park the row and stash how far the server got, so a resume continues
			// from there instead of restarting.
			item.status = "paused";
			item.stage = "paused";
			item.resumeFrom = asNumber(event.resume_from, item.resumeFrom ?? 0);
			item.priorSegments = parsePartialSegments(event.partial_segments);
			item.pausedByUser = reason === "userPause";
		}
		emitQueue();
		// Manual-paused rows stay; the pump skips them and processes other queued
		// files, so a stopped file never blocks newly-dropped ones.
		if (!dictationPaused) {
			schedulePump();
		}
	}

	function applyTerminal(requestId: string): void {
		if (activeRequestId === requestId) {
			activeRequestId = null;
		}
		emitQueue();
		schedulePump();
	}

	function applyServerEvent(
		item: QueueItem,
		type: string,
		requestId: string,
		event: Record<string, unknown>
	): void {
		if (type === "file_transcription_progress") {
			item.progress = asNumber(event.progress, item.progress);
			item.stage = asString(event.stage) || item.stage;
			item.message = asString(event.message) || item.message;
			emitProgress(item);
			return;
		}
		if (type === "file_transcription_complete") {
			item.status = "complete";
			item.progress = 1;
			item.stage = "complete";
			item.text = asString(event.text);
			item.resumeFrom = undefined;
			item.priorSegments = undefined;
			applyTerminal(requestId);
			return;
		}
		if (type === "file_transcription_error") {
			item.status = "error";
			item.stage = "error";
			item.message = asString(event.error) || "Transcription failed";
			applyTerminal(requestId);
			return;
		}
		if (type === "file_transcription_canceled") {
			handleCanceledEvent(item, event);
		}
	}

	function onDataEvent(event: Record<string, unknown>): void {
		const type = event.type;
		if (typeof type !== "string") {
			return;
		}
		const requestId = asString(event.request_id);
		if (!requestId) {
			return;
		}
		const item = findByRequestId(requestId);
		if (item) {
			applyServerEvent(item, type, requestId, event);
		}
	}

	// ── Push-to-talk auto-pause (whole queue; the model is busy dictating) ──
	function pauseForDictation(): void {
		if (dictationPaused) {
			return;
		}
		dictationPaused = true;
		// Park the in-flight file so the model is freed for dictation. If it's still
		// in pump()'s dispatch window (no requestId), the post-await guard sends the
		// cancel once the id is known.
		const active = items.find((it) => it.status === "transcribing");
		if (active?.requestId) {
			pendingCancelReason = "dictation";
			client.sendControl({ command: "cancel_file_transcription", request_id: active.requestId });
		}
		emitQueue();
	}

	function resumeAfterDictation(): void {
		if (!dictationPaused) {
			return;
		}
		dictationPaused = false;
		// Re-queue ONLY the rows dictation parked; rows the USER stopped stay paused
		// until they resume them. They keep their resume state, so each continues
		// from where it left off.
		for (const it of items) {
			if (it.status === "paused" && !it.pausedByUser) {
				it.status = "queued";
				it.stage = "queued";
			}
		}
		emitQueue();
		schedulePump();
	}

	// ── Per-row manual Pause / Resume ──
	function pauseItem(id: string): void {
		const item = items.find((it) => it.id === id);
		if (!item || item.status !== "transcribing") {
			return;
		}
		pendingCancelReason = "userPause";
		if (item.requestId) {
			client.sendControl({ command: "cancel_file_transcription", request_id: item.requestId });
		}
		// Pre-dispatch (no requestId): pump's post-await guard sends the cancel.
	}

	function resumeItem(id: string): void {
		const item = items.find((it) => it.id === id);
		if (!item || item.status !== "paused") {
			return;
		}
		item.status = "queued";
		item.stage = "queued";
		item.pausedByUser = undefined;
		emitQueue();
		schedulePump();
	}

	// Discard everything — cancel the in-flight file and drop all rows, returning
	// the main window to the visualizer immediately. Completed transcripts are
	// already saved to disk, so this only clears the queue UI / pending work.
	function discardAll(): void {
		const active = items.find((it) => it.status === "transcribing");
		if (active?.requestId) {
			client.sendControl({ command: "cancel_file_transcription", request_id: active.requestId });
			pendingRequests.delete(active.requestId);
		}
		items.length = 0;
		activeRequestId = null;
		pendingCancelReason = null;
		emitQueue();
	}

	const unsubscribeDictation = onDictationActiveChange((active) => {
		if (active) {
			pauseForDictation();
		} else {
			resumeAfterDictation();
		}
	});

	// ── Connection lifecycle: keep the queue resilient across reconnects ──
	const onConnected = (): void => {
		schedulePump();
	};
	const onDisconnected = (): void => {
		if (!activeRequestId) {
			return;
		}
		const item = findByRequestId(activeRequestId);
		if (item && item.status === "transcribing") {
			// The in-flight file is lost when the socket drops — re-queue it so it
			// restarts once the server is back. Drop its stale pendingRequests entry
			// so a late complete for the OLD id (the server daemon survives the WS
			// drop) doesn't make the base layer write the output twice. Resume state
			// (if any) is kept, so it continues from the last confirmed point.
			if (item.requestId) {
				pendingRequests.delete(item.requestId);
			}
			item.status = "queued";
			item.stage = "queued";
			item.requestId = undefined;
		}
		activeRequestId = null;
		pendingCancelReason = null;
		emitQueue();
	};

	// ── Renderer → main commands ───────────────────────────────────────
	function enqueue(payload: EnqueuePayload): void {
		const files = Array.isArray(payload?.files) ? payload.files : [];
		let added = false;
		for (const f of files) {
			const filePath = asString(f?.filePath);
			if (!filePath) {
				continue;
			}
			counter += 1;
			items.push({
				id: `fq-${counter}-${Date.now()}`,
				filePath,
				fileName: asString(f?.fileName) || path.basename(filePath),
				status: "queued",
				progress: 0,
				stage: "queued",
				message: "",
			});
			added = true;
		}
		if (added) {
			emitQueue();
			schedulePump();
		}
	}

	function cancel(id: string): void {
		const item = items.find((it) => it.id === id);
		if (!item) {
			return;
		}
		// Discarding the in-flight file: cancel it on the server; the canceled event
		// removes the row (covers the pre-dispatch window — post-await sends it).
		if (item.status === "transcribing") {
			pendingCancelReason = "userCancel";
			if (item.requestId) {
				client.sendControl({ command: "cancel_file_transcription", request_id: item.requestId });
			}
			return;
		}
		removeItem(id);
		emitQueue();
	}

	function retry(id: string): void {
		const item = items.find((it) => it.id === id);
		if (!item || item.status === "transcribing") {
			return;
		}
		item.status = "queued";
		item.progress = 0;
		item.stage = "queued";
		item.message = "";
		item.requestId = undefined;
		item.text = undefined;
		item.resumeFrom = undefined;
		item.priorSegments = undefined;
		item.pausedByUser = undefined;
		emitQueue();
		schedulePump();
	}

	function copy(id: string): void {
		const item = items.find((it) => it.id === id);
		if (item?.text) {
			clipboard.writeText(item.text);
		}
	}

	function clearFinished(): void {
		for (let i = items.length - 1; i >= 0; i -= 1) {
			const status = items[i]?.status;
			if (status && isTerminalStatus(status)) {
				items.splice(i, 1);
			}
		}
		emitQueue();
	}

	ipcMain.handle("file:queue-enqueue", (_event, payload: EnqueuePayload) => {
		enqueue(payload);
	});
	ipcMain.handle("file:queue-cancel", (_event, payload: { id?: string }) => {
		cancel(asString(payload?.id));
	});
	ipcMain.handle("file:queue-retry", (_event, payload: { id?: string }) => {
		retry(asString(payload?.id));
	});
	ipcMain.handle("file:queue-copy", (_event, payload: { id?: string }) => {
		copy(asString(payload?.id));
	});
	ipcMain.handle("file:queue-clear", () => {
		clearFinished();
	});
	ipcMain.handle("file:queue-pause", (_event, payload: { id?: string }) => {
		pauseItem(asString(payload?.id));
	});
	ipcMain.handle("file:queue-resume", (_event, payload: { id?: string }) => {
		resumeItem(asString(payload?.id));
	});
	ipcMain.handle("file:queue-discard-all", () => {
		discardAll();
	});
	// Initial-state pull for windows created AFTER a busy transition (the
	// broadcast is edge-triggered). The detached model-picker queries this on
	// mount so its selector reflects the queue even when opened mid-transcription.
	ipcMain.handle("file:queue-get-active", () => items.some((it) => isBusyStatus(it.status)));

	client.on("data-event", onDataEvent);
	client.on("connected", onConnected);
	client.on("disconnected", onDisconnected);

	return {
		cleanup: () => {
			ipcMain.removeHandler("file:queue-enqueue");
			ipcMain.removeHandler("file:queue-cancel");
			ipcMain.removeHandler("file:queue-retry");
			ipcMain.removeHandler("file:queue-copy");
			ipcMain.removeHandler("file:queue-clear");
			ipcMain.removeHandler("file:queue-pause");
			ipcMain.removeHandler("file:queue-resume");
			ipcMain.removeHandler("file:queue-discard-all");
			ipcMain.removeHandler("file:queue-get-active");
			client.off("data-event", onDataEvent);
			client.off("connected", onConnected);
			client.off("disconnected", onDisconnected);
			unsubscribeDictation();
			if (autoClearTimer) {
				clearTimeout(autoClearTimer);
				autoClearTimer = null;
			}
		},
	};
}

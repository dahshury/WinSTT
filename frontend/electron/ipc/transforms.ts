import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { getErrorMessage, ValidationError } from "../../src/shared/lib/errors";
import { dbg } from "../lib/debug-log";
import { isPlainObject } from "../lib/ipc-helpers";
import { pasteText } from "../lib/paste";
import { captureSelection } from "../lib/selection-capture";
import { getStoreValue } from "../lib/store";
import { processText } from "./llm";

interface PreviewPayload {
	feature: "dictation" | "transforms";
	text: string;
}

function asRecord(payload: unknown, label: string): Record<string, unknown> {
	if (!isPlainObject(payload)) {
		throw new ValidationError(`${label} payload must be an object`, "payload");
	}
	return payload;
}

const VALID_PREVIEW_FEATURES = new Set(["dictation", "transforms"] as const);

function isValidPreviewFeature(value: unknown): value is PreviewPayload["feature"] {
	return (
		typeof value === "string" && VALID_PREVIEW_FEATURES.has(value as "dictation" | "transforms")
	);
}

function assertPreviewPayload(payload: unknown): asserts payload is PreviewPayload {
	const obj = asRecord(payload, "LLM preview");
	if (typeof obj.text !== "string") {
		throw new ValidationError("LLM preview payload.text must be a string", "text");
	}
	if (!isValidPreviewFeature(obj.feature)) {
		throw new ValidationError(
			"LLM preview payload.feature must be 'dictation' or 'transforms'",
			"feature"
		);
	}
}

function hasTransformsModel(): boolean {
	if (getStoreValue("llm.transforms.provider") === "openrouter") {
		return Boolean(getStoreValue("llm.openrouterApiKey"));
	}
	return Boolean(getStoreValue("llm.transforms.model"));
}

/**
 * Transforms run when the transforms feature is enabled and a model is
 * configured for its chosen provider. There is no master switch —
 * dictation has its own independent gate in relay.ts.
 */
function isTransformsEnabled(): boolean {
	return getStoreValue("llm.transforms.enabled") === true && hasTransformsModel();
}

function sendToWindow(win: BrowserWindow, channel: string, payload: unknown): void {
	if (win.isDestroyed()) {
		return;
	}
	try {
		win.webContents.send(channel, payload);
	} catch (err) {
		dbg("transforms", `broadcast failed: ${getErrorMessage(err)}`);
	}
}

function broadcastAll(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		sendToWindow(win, channel, payload);
	}
}

/** Broadcast `transforms:failed` and throw a {@link ValidationError}. */
function fail(message: string, field: string): never {
	broadcastAll(IPC.TRANSFORMS_FAILED, { reason: message });
	throw new ValidationError(message, field);
}

function requireEnabled(): void {
	if (!isTransformsEnabled()) {
		fail("LLM text transformation is disabled", "transformsEnabled");
	}
}

async function runLlm(text: string): Promise<string> {
	try {
		return await processText(text, "", "transforms");
	} catch (err) {
		const reason = getErrorMessage(err);
		dbg("transforms", `LLM call failed: ${reason}`);
		broadcastAll(IPC.TRANSFORMS_FAILED, { reason });
		throw err;
	}
}

export interface ApplyResult {
	after: string;
	before: string;
	source: "uia" | "clipboard" | "empty";
}

/**
 * End-to-end Transforms pipeline: capture selection → run the composed
 * presets+modifiers prompt → paste-replace. Used by both the IPC handler
 * (renderer invoke) and the hotkey listener (uIOhook keydown match).
 *
 * Resolves with the {@link ApplyResult} on success. On failure, emits the
 * `transforms:failed` event and re-throws — the IPC layer surfaces the
 * error to the renderer for the toast.
 */
async function runTransformPipeline(): Promise<ApplyResult> {
	requireEnabled();

	const selection = await captureSelection();
	if (!selection.text.trim()) {
		broadcastAll(IPC.TRANSFORMS_FAILED, { reason: "No text selected" });
		return { before: "", after: "", source: selection.source };
	}

	const transformed = await runLlm(selection.text);

	// Paste replaces the selection. pasteText() mirrors to clipboard, then
	// the native helper sends SendInput Ctrl+V — which, because the
	// selection is highlighted in the target app, overwrites it.
	pasteText(transformed);

	broadcastAll(IPC.TRANSFORMS_APPLIED, {
		before: selection.text,
		after: transformed,
		source: selection.source,
	});

	return {
		before: selection.text,
		after: transformed,
		source: selection.source,
	};
}

export async function applyTransform(): Promise<ApplyResult> {
	return await runTransformPipeline();
}

export function setupTransforms(): () => void {
	const handleApply = async () => await applyTransform();

	// Playground: feeds the user's sample text through the chosen feature's
	// full pipeline (composed presets+modifiers + provider/model), bypassing
	// selection capture and paste. Same code path the runtime would take —
	// only the input/output sites differ.
	const handlePreview = async (_event: unknown, payload: unknown) => {
		assertPreviewPayload(payload);
		return await processText(payload.text, "", payload.feature);
	};

	ipcMain.handle(IPC.TRANSFORMS_APPLY, handleApply);
	ipcMain.handle(IPC.TRANSFORMS_PREVIEW, handlePreview);

	return () => {
		ipcMain.removeHandler(IPC.TRANSFORMS_APPLY);
		ipcMain.removeHandler(IPC.TRANSFORMS_PREVIEW);
	};
}

export const __transforms_test_helpers__ = {
	assertPreviewPayload,
	asRecord,
	broadcastAll,
	hasTransformsModel,
	isTransformsEnabled,
	requireEnabled,
	runLlm,
	runTransformPipeline,
	sendToWindow,
};

import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { getErrorMessage, ValidationError } from "../../src/shared/lib/errors";
import { dbg } from "../lib/debug-log";
import { isPlainObject } from "../lib/ipc-helpers";
import { pasteText } from "../lib/paste";
import { captureSelection } from "../lib/selection-capture";
import { getStoreValue } from "../lib/store";
import { processTextWithCustomPrompt } from "./llm";

interface StoredTransform {
	builtin: boolean;
	hotkey: string;
	id: string;
	name: string;
	prompt: string;
}

interface ApplyPayload {
	transformId: string;
}

interface PreviewPayload {
	systemPrompt: string;
	text: string;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function asRecord(payload: unknown, label: string): Record<string, unknown> {
	if (!isPlainObject(payload)) {
		throw new ValidationError(`${label} payload must be an object`, "payload");
	}
	return payload;
}

function assertApplyPayload(payload: unknown): asserts payload is ApplyPayload {
	const obj = asRecord(payload, "Transform apply");
	if (!isNonEmptyString(obj.transformId)) {
		throw new ValidationError("Transform apply payload.transformId is required", "transformId");
	}
}

function assertPreviewPayload(payload: unknown): asserts payload is PreviewPayload {
	const obj = asRecord(payload, "Transform preview");
	if (typeof obj.text !== "string") {
		throw new ValidationError("Transform preview payload.text must be a string", "text");
	}
	if (!isNonEmptyString(obj.systemPrompt)) {
		throw new ValidationError("Transform preview payload.systemPrompt is required", "systemPrompt");
	}
}

function findTransform(transformId: string): StoredTransform | undefined {
	const prompts = getStoreValue("llm.transforms.prompts");
	return prompts.find((t) => t.id === transformId);
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
		dbg("transforms", `broadcast failed: ${(err as Error).message}`);
	}
}

function broadcastAll(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		sendToWindow(win, channel, payload);
	}
}

/** Broadcast `transforms:failed` and throw a {@link ValidationError}. */
function fail(transformId: string, message: string, field: string): never {
	broadcastAll(IPC.TRANSFORMS_FAILED, { transformId, reason: message });
	throw new ValidationError(message, field);
}

function requireEnabledTransform(transformId: string): StoredTransform {
	if (!isTransformsEnabled()) {
		fail(transformId, "LLM text transformation is disabled", "transformsEnabled");
	}
	const transform = findTransform(transformId);
	if (!transform) {
		fail(transformId, `Transform "${transformId}" not found`, "transformId");
	}
	return transform;
}

function requirePrompt(transform: StoredTransform): void {
	if (!transform.prompt.trim()) {
		fail(transform.id, `Transform "${transform.name}" has no prompt`, "prompt");
	}
}

async function runLlm(transformId: string, text: string, prompt: string): Promise<string> {
	try {
		return await processTextWithCustomPrompt(text, prompt);
	} catch (err) {
		const reason = getErrorMessage(err);
		dbg("transforms", `LLM call failed: ${reason}`);
		broadcastAll(IPC.TRANSFORMS_FAILED, { transformId, reason });
		throw err;
	}
}

export interface ApplyResult {
	after: string;
	before: string;
	source: "uia" | "clipboard" | "empty";
	transformId: string;
}

/**
 * End-to-end Transforms pipeline: capture selection → run LLM with the
 * transform's custom prompt → paste-replace. Used by both the IPC handler
 * (renderer invoke) and the hotkey listener (uIOhook keydown match).
 *
 * Resolves with the {@link ApplyResult} on success. On failure, emits the
 * `transforms:failed` event and re-throws — the IPC layer surfaces the
 * error to the renderer for the toast.
 */
async function runTransformPipeline(transformId: string): Promise<ApplyResult> {
	const transform = requireEnabledTransform(transformId);
	requirePrompt(transform);

	const selection = await captureSelection();
	if (!selection.text.trim()) {
		broadcastAll(IPC.TRANSFORMS_FAILED, {
			transformId,
			reason: "No text selected",
		});
		return {
			transformId,
			before: "",
			after: "",
			source: selection.source,
		};
	}

	const transformed = await runLlm(transformId, selection.text, transform.prompt);

	// Paste replaces the selection. pasteText() mirrors to clipboard, then
	// the native helper sends SendInput Ctrl+V — which, because the
	// selection is highlighted in the target app, overwrites it.
	pasteText(transformed);

	broadcastAll(IPC.TRANSFORMS_APPLIED, {
		transformId,
		before: selection.text,
		after: transformed,
		source: selection.source,
		transformName: transform.name,
	});

	return {
		transformId,
		before: selection.text,
		after: transformed,
		source: selection.source,
	};
}

export async function applyTransform(transformId: string): Promise<ApplyResult> {
	return await runTransformPipeline(transformId);
}

export function setupTransforms(): () => void {
	const handleApply = async (_event: unknown, payload: unknown) => {
		assertApplyPayload(payload);
		return await applyTransform(payload.transformId);
	};

	// Playground: feeds the user's WIP prompt + sample text through the LLM
	// without touching their clipboard, selection, or any external app.
	const handlePreview = async (_event: unknown, payload: unknown) => {
		assertPreviewPayload(payload);
		return await processTextWithCustomPrompt(payload.text, payload.systemPrompt);
	};

	ipcMain.handle(IPC.TRANSFORMS_APPLY, handleApply);
	ipcMain.handle(IPC.TRANSFORMS_PREVIEW, handlePreview);

	return () => {
		ipcMain.removeHandler(IPC.TRANSFORMS_APPLY);
		ipcMain.removeHandler(IPC.TRANSFORMS_PREVIEW);
	};
}

export const __transforms_test_helpers__ = {
	assertApplyPayload,
	assertPreviewPayload,
	asRecord,
	broadcastAll,
	findTransform,
	hasTransformsModel,
	isNonEmptyString,
	isTransformsEnabled,
	requireEnabledTransform,
	requirePrompt,
	runLlm,
	runTransformPipeline,
	sendToWindow,
};

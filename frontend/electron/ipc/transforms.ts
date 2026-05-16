import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { getErrorMessage, ValidationError } from "../../src/shared/lib/errors";
import { dbg } from "../lib/debug-log";
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertApplyPayload(payload: unknown): asserts payload is ApplyPayload {
	if (!isPlainObject(payload)) {
		throw new ValidationError("Transform apply payload must be an object", "payload");
	}
	if (typeof payload.transformId !== "string" || payload.transformId.length === 0) {
		throw new ValidationError("Transform apply payload.transformId is required", "transformId");
	}
}

function assertPreviewPayload(payload: unknown): asserts payload is PreviewPayload {
	if (!isPlainObject(payload)) {
		throw new ValidationError("Transform preview payload must be an object", "payload");
	}
	const text = payload.text;
	const systemPrompt = payload.systemPrompt;
	if (typeof text !== "string") {
		throw new ValidationError("Transform preview payload.text must be a string", "text");
	}
	if (typeof systemPrompt !== "string" || systemPrompt.length === 0) {
		throw new ValidationError("Transform preview payload.systemPrompt is required", "systemPrompt");
	}
}

function findTransform(transformId: string): StoredTransform | undefined {
	const transforms = getStoreValue("llm.transforms");
	return transforms.find((t) => t.id === transformId);
}

function hasLlmModel(): boolean {
	if (getStoreValue("llm.provider") === "openrouter") {
		return Boolean(getStoreValue("llm.openrouterApiKey"));
	}
	return Boolean(getStoreValue("llm.model"));
}

/**
 * Transforms run only when the LLM master switch AND the transforms
 * sub-feature are both on, with a model configured. Mirrors the dictation
 * gate in relay.ts (`isLlmConfigured`) but keyed off `llm.transformsEnabled`.
 */
function isTransformsEnabled(): boolean {
	return (
		getStoreValue("llm.enabled") === true &&
		getStoreValue("llm.transformsEnabled") === true &&
		hasLlmModel()
	);
}

function broadcastAll(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			try {
				win.webContents.send(channel, payload);
			} catch (err) {
				dbg("transforms", `broadcast failed: ${(err as Error).message}`);
			}
		}
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
export async function applyTransform(transformId: string): Promise<ApplyResult> {
	if (!isTransformsEnabled()) {
		const message = "LLM text transformation is disabled";
		broadcastAll(IPC.TRANSFORMS_FAILED, { transformId, reason: message });
		throw new ValidationError(message, "transformsEnabled");
	}
	const transform = findTransform(transformId);
	if (!transform) {
		const message = `Transform "${transformId}" not found`;
		broadcastAll(IPC.TRANSFORMS_FAILED, { transformId, reason: message });
		throw new ValidationError(message, "transformId");
	}
	if (!transform.prompt.trim()) {
		const message = `Transform "${transform.name}" has no prompt`;
		broadcastAll(IPC.TRANSFORMS_FAILED, { transformId, reason: message });
		throw new ValidationError(message, "prompt");
	}

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

	let transformed: string;
	try {
		transformed = await processTextWithCustomPrompt(selection.text, transform.prompt);
	} catch (err) {
		const reason = getErrorMessage(err);
		dbg("transforms", `LLM call failed: ${reason}`);
		broadcastAll(IPC.TRANSFORMS_FAILED, { transformId, reason });
		throw err;
	}

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
	findTransform,
};

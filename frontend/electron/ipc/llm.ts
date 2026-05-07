import { execFile, spawn } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ipcMain } from "electron";
import { z } from "zod";
import { PRESET_PROMPTS } from "../../src/entities/llm-catalog/lib/ollama-client";
import { IPC } from "../../src/shared/api/ipc-channels";
import {
	ConnectionError,
	getErrorMessage,
	TimeoutError,
	ValidationError,
} from "../../src/shared/lib/errors";
import { buildOllamaApiUrl, normalizeOllamaEndpoint } from "../../src/shared/lib/ollama-endpoint";
import { dbg } from "../lib/debug-log";
import { getStoreValue } from "../lib/store";

const execFileAsync = promisify(execFile);
const NEWLINE_RE = /\r?\n/;

// ── Zod schemas for Ollama API responses (external boundary) ──────────

const ollamaTagsModelSchema = z.object({
	name: z.string(),
	size: z.number(),
	modified_at: z.string().optional(),
	modifiedAt: z.string().optional(),
});

const ollamaTagsResponseSchema = z.object({
	models: z.array(ollamaTagsModelSchema).optional(),
});

const ollamaChatResponseSchema = z.object({
	model: z.string(),
	created_at: z.string(),
	message: z.object({
		role: z.string(),
		content: z.string(),
	}),
	done: z.boolean(),
});

interface OllamaModel {
	name: string;
	size: number;
	modifiedAt: string;
}

interface OllamaScanResult {
	models: OllamaModel[];
	reachable: boolean;
	error?: string;
}

interface OllamaChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export async function scanOllamaModels(endpoint: string): Promise<OllamaScanResult> {
	// Validate endpoint
	if (!endpoint || typeof endpoint !== "string") {
		throw new ValidationError("LLM endpoint is required", "endpoint");
	}
	const normalizedEndpoint = normalizeOllamaEndpoint(endpoint);
	if (!normalizedEndpoint) {
		throw new ValidationError("LLM endpoint is required", "endpoint");
	}

	let response: Response;
	try {
		response = await fetch(buildOllamaApiUrl(normalizedEndpoint, "/api/tags"), {
			method: "GET",
			headers: { "Content-Type": "application/json" },
			signal: AbortSignal.timeout(5000),
		});
	} catch (err) {
		// Connection failures (Ollama not running) are expected — log once and degrade.
		const message = getErrorMessage(err);
		dbg("llm", `Ollama unreachable at ${normalizedEndpoint}:`, message);
		return { models: [], reachable: false, error: message };
	}

	// Ollama answered, so it's reachable — even if the response is an error.
	if (!response.ok) {
		const message = `Ollama /api/tags returned HTTP ${response.status}`;
		dbg("llm", `${message} at ${normalizedEndpoint}`);
		return { models: [], reachable: true, error: message };
	}

	const json: unknown = await response.json();
	const parsed = ollamaTagsResponseSchema.safeParse(json);
	if (!parsed.success) {
		dbg("llm", "Ollama /api/tags response did not match expected schema:", parsed.error.message);
		return { models: [], reachable: true, error: "Unexpected response shape from Ollama" };
	}
	const models = (parsed.data.models ?? []).map((modelItem) => ({
		name: modelItem.name,
		size: modelItem.size,
		modifiedAt: modelItem.modifiedAt ?? modelItem.modified_at ?? "",
	}));
	return { models, reachable: true };
}

/**
 * Process text using Ollama's chat API with proper structured output.
 * Uses /api/chat endpoint with system/user messages for better context handling.
 */
export async function processText(
	text: string,
	model: string,
	preset: string,
	endpoint: string,
	timeout: number
): Promise<string> {
	// Validate inputs
	if (!text || typeof text !== "string") {
		throw new ValidationError("Text is required for LLM processing", "text");
	}
	if (!model || typeof model !== "string") {
		throw new ValidationError("Model name is required", "model");
	}
	if (!endpoint || typeof endpoint !== "string") {
		throw new ValidationError("LLM endpoint is required", "endpoint");
	}
	const normalizedEndpoint = normalizeOllamaEndpoint(endpoint);
	if (!normalizedEndpoint) {
		throw new ValidationError("LLM endpoint is required", "endpoint");
	}

	const systemPrompt =
		(preset in PRESET_PROMPTS
			? PRESET_PROMPTS[preset as keyof typeof PRESET_PROMPTS]
			: undefined) ?? PRESET_PROMPTS.neutral;
	const userPrompt = `Transform the following text according to the style guide above. Return ONLY the transformed text with no additional commentary, explanations, or JSON formatting. Just the plain transformed text.\n\nText to transform:\n${text}`;

	const messages: OllamaChatMessage[] = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userPrompt },
	];

	try {
		// Use /api/chat endpoint for better system prompt support
		const response = await fetch(buildOllamaApiUrl(normalizedEndpoint, "/api/chat"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages,
				stream: false,
				options: {
					temperature: 0.3,
					top_p: 0.9,
					num_predict: Math.max(text.length * 2, 100), // Allow response up to 2x input length
				},
			}),
			signal: AbortSignal.timeout(timeout),
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "Unknown error");
			throw new ConnectionError(
				`LLM API request failed: HTTP ${response.status} - ${errorText}`,
				normalizedEndpoint,
				false,
				{ model, preset, statusCode: response.status }
			);
		}

		const chatJson: unknown = await response.json();
		const chatParsed = ollamaChatResponseSchema.safeParse(chatJson);
		if (!chatParsed.success) {
			dbg(
				"llm",
				"Ollama /api/chat response did not match expected schema:",
				chatParsed.error.message
			);
			return text;
		}
		const generated = chatParsed.data.message.content.trim();

		if (!generated) {
			dbg("llm", "Empty response from LLM, using original text");
			return text;
		}

		// Return the generated text directly (no JSON parsing needed)
		return generated;
	} catch (err) {
		dbg("llm", "LLM processing failed:", getErrorMessage(err));

		// Re-throw typed errors
		if (
			err instanceof ConnectionError ||
			err instanceof TimeoutError ||
			err instanceof ValidationError
		) {
			throw err;
		}

		// Handle timeout
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new TimeoutError(timeout, "LLM text processing", {
				endpoint: normalizedEndpoint,
				model,
				preset,
				textLength: text.length,
				originalError: err,
			});
		}

		// Return original text on unknown error (graceful degradation)
		console.error("[llm] Unexpected error during processing, returning original text:", err);
		return text;
	}
}

interface OllamaDetectResult {
	installed: boolean;
	path?: string;
}

/**
 * Locate an `ollama` executable on PATH or in known default install locations.
 * Returns `installed: true` only if the file actually exists on disk.
 */
export async function detectOllama(): Promise<OllamaDetectResult> {
	if (process.platform !== "win32") {
		// On non-Windows, just probe PATH via `which`.
		try {
			const { stdout } = await execFileAsync("which", ["ollama"], { timeout: 2000 });
			const resolved = stdout.trim();
			if (resolved) {
				return { installed: true, path: resolved };
			}
		} catch {
			// fall through
		}
		return { installed: false };
	}

	// Windows: try `where ollama` first.
	try {
		const { stdout } = await execFileAsync("where", ["ollama"], { timeout: 2000 });
		const firstLine = stdout.split(NEWLINE_RE).find((l) => l.trim().length > 0);
		if (firstLine) {
			return { installed: true, path: firstLine.trim() };
		}
	} catch {
		// `where` failed — keep probing default locations.
	}

	const candidates: string[] = [];
	const localAppData = process.env.LOCALAPPDATA;
	if (localAppData) {
		candidates.push(path.join(localAppData, "Programs", "Ollama", "ollama.exe"));
	}
	const programFiles = process.env.ProgramFiles;
	if (programFiles) {
		candidates.push(path.join(programFiles, "Ollama", "ollama.exe"));
	}

	for (const candidate of candidates) {
		try {
			await fsPromises.access(candidate);
			return { installed: true, path: candidate };
		} catch {
			// try next
		}
	}
	return { installed: false };
}

/**
 * Launch the Ollama process detached. The Windows installer registers `ollama app.exe`
 * which boots the system-tray app + serves the API; falling back to `ollama serve` works
 * when only the CLI is on PATH.
 */
export async function startOllama(): Promise<{ started: boolean; error?: string }> {
	const detected = await detectOllama();
	if (!(detected.installed && detected.path)) {
		return { started: false, error: "Ollama is not installed" };
	}
	try {
		const child = spawn(detected.path, ["serve"], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.on("error", (err) => {
			dbg("llm", "Ollama spawn error:", err.message);
		});
		child.unref();
		dbg("llm", `Started Ollama from ${detected.path}`);
		return { started: true };
	} catch (err) {
		const message = getErrorMessage(err);
		dbg("llm", "Failed to start Ollama:", message);
		return { started: false, error: message };
	}
}

export function setupLlm(): () => void {
	const handleScanModels = async () => {
		const endpoint = getStoreValue("llm.endpoint");
		return await scanOllamaModels(endpoint);
	};

	const handleDetectOllama = async () => detectOllama();

	const handleStartOllama = async () => startOllama();

	const handleProcessText = async (
		_event: unknown,
		payload: { text: string; model: string; preset: string }
	) => {
		try {
			if (!payload || typeof payload !== "object") {
				throw new ValidationError("LLM process-text payload must be an object", "payload");
			}
			if (typeof payload.text !== "string") {
				throw new ValidationError("LLM process-text payload.text must be a string", "text");
			}
			if (typeof payload.model !== "string") {
				throw new ValidationError("LLM process-text payload.model must be a string", "model");
			}
			if (typeof payload.preset !== "string") {
				throw new ValidationError("LLM process-text payload.preset must be a string", "preset");
			}
			const { text, model, preset } = payload;
			const endpoint = getStoreValue("llm.endpoint");
			const timeout = getStoreValue("llm.timeout");
			return await processText(text, model, preset, endpoint, timeout);
		} catch (error) {
			console.error("[llm] Failed to process text:", getErrorMessage(error));
			throw error;
		}
	};

	ipcMain.handle(IPC.LLM_SCAN_MODELS, handleScanModels);
	ipcMain.handle(IPC.LLM_PROCESS_TEXT, handleProcessText);
	ipcMain.handle(IPC.LLM_DETECT_OLLAMA, handleDetectOllama);
	ipcMain.handle(IPC.LLM_START_OLLAMA, handleStartOllama);

	return () => {
		ipcMain.removeHandler(IPC.LLM_SCAN_MODELS);
		ipcMain.removeHandler(IPC.LLM_PROCESS_TEXT);
		ipcMain.removeHandler(IPC.LLM_DETECT_OLLAMA);
		ipcMain.removeHandler(IPC.LLM_START_OLLAMA);
	};
}

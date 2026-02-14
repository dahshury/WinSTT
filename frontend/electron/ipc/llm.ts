import { ipcMain } from "electron";
import type Store from "electron-store";
import { IPC } from "../../src/shared/api/ipc-channels";
import type { AppSettingsOutput } from "../../src/shared/config/settings-schema";
import {
	ConnectionError,
	getErrorMessage,
	TimeoutError,
	ValidationError,
} from "../../src/shared/lib/errors";
import { dbg } from "../lib/debug-log";

interface OllamaModel {
	name: string;
	size: number;
	modified_at: string;
}

interface OllamaChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface OllamaChatResponse {
	model: string;
	created_at: string;
	message: {
		role: string;
		content: string;
	};
	done: boolean;
}

async function scanOllamaModels(endpoint: string): Promise<OllamaModel[]> {
	// Validate endpoint
	if (!endpoint || typeof endpoint !== "string") {
		throw new ValidationError("LLM endpoint is required", "endpoint");
	}

	try {
		const response = await fetch(`${endpoint}/api/tags`, {
			method: "GET",
			headers: { "Content-Type": "application/json" },
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) {
			throw new ConnectionError(
				`Failed to connect to Ollama API: HTTP ${response.status}`,
				endpoint,
				true
			);
		}

		const data = (await response.json()) as { models: OllamaModel[] };
		return data.models ?? [];
	} catch (err) {
		dbg("llm", "Failed to scan Ollama models:", getErrorMessage(err));

		// Re-throw typed errors as-is
		if (
			err instanceof ConnectionError ||
			err instanceof TimeoutError ||
			err instanceof ValidationError
		) {
			throw err;
		}

		// Handle timeout
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new TimeoutError(5000, "scanOllamaModels", { endpoint, originalError: err });
		}

		// Wrap unknown errors
		throw new ConnectionError(
			`Could not connect to Ollama at ${endpoint}. Ensure Ollama is running and accessible.`,
			endpoint,
			true,
			{ originalError: err }
		);
	}
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

	const PRESET_PROMPTS: Record<string, string> = {
		neutral: "Fix grammar and punctuation only. Preserve the original tone and style.",
		formal: "Convert to professional business English with formal tone.",
		friendly: "Make the text warm, conversational, and approachable.",
		technical: "Use precise technical terminology and formal structure.",
		casual: "Make relaxed and conversational with natural contractions.",
		concise: "Remove unnecessary words while keeping all key information.",
	};

	const systemPrompt =
		PRESET_PROMPTS[preset] ||
		PRESET_PROMPTS.neutral ||
		"Fix grammar and punctuation only. Preserve the original tone and style.";
	const userPrompt = `Transform the following text according to the style guide above. Return ONLY the transformed text with no additional commentary, explanations, or JSON formatting. Just the plain transformed text.\n\nText to transform:\n${text}`;

	const messages: OllamaChatMessage[] = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userPrompt },
	];

	try {
		// Use /api/chat endpoint for better system prompt support
		const response = await fetch(`${endpoint}/api/chat`, {
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
				endpoint,
				false,
				{ model, preset, statusCode: response.status }
			);
		}

		const data = (await response.json()) as OllamaChatResponse;
		const generated = data.message?.content?.trim() ?? "";

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
				endpoint,
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

export function setupLlm(store: Store<AppSettingsOutput>): () => void {
	const handleScanModels = async () => {
		try {
			const endpoint = (store.get("llm.endpoint") as string) ?? "http://localhost:11434";
			return await scanOllamaModels(endpoint);
		} catch (error) {
			console.error("[llm] Failed to scan models:", getErrorMessage(error));
			throw error;
		}
	};

	const handleProcessText = async (
		_event: unknown,
		payload: { text: string; model: string; preset: string }
	) => {
		try {
			const { text, model, preset } = payload;
			const endpoint = (store.get("llm.endpoint") as string) ?? "http://localhost:11434";
			const timeout = (store.get("llm.timeout") as number) ?? 5000;
			return await processText(text, model, preset, endpoint, timeout);
		} catch (error) {
			console.error("[llm] Failed to process text:", getErrorMessage(error));
			throw error;
		}
	};

	ipcMain.handle(IPC.LLM_SCAN_MODELS, handleScanModels);
	ipcMain.handle(IPC.LLM_PROCESS_TEXT, handleProcessText);

	return () => {
		ipcMain.removeHandler(IPC.LLM_SCAN_MODELS);
		ipcMain.removeHandler(IPC.LLM_PROCESS_TEXT);
	};
}

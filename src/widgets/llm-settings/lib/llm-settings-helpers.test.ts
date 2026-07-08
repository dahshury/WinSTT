import { describe, expect, mock, test } from "bun:test";
import {
	applyOllamaModelReplacementIfNeeded,
	buildOllamaStartError,
	getOllamaPrimaryAction,
	getOllamaPrimaryLabelKey,
	isApiKeyValid,
	ollamaModelSyncNeeded,
	pickNearestOllamaModel,
	readInputValue,
	resolvePlaygroundLocalModel,
} from "./llm-settings-helpers";

describe("isApiKeyValid", () => {
	test("returns true for a non-empty trimmed key", () => {
		expect(isApiKeyValid("sk-test")).toBe(true);
		expect(isApiKeyValid("  x  ")).toBe(true);
	});

	test("returns false for empty string", () => {
		expect(isApiKeyValid("")).toBe(false);
	});

	test("returns false for whitespace-only string", () => {
		expect(isApiKeyValid("   ")).toBe(false);
	});
});

describe("getOllamaPrimaryAction", () => {
	test("returns 'run' when showRun is true", () => {
		expect(getOllamaPrimaryAction(true)).toBe("run");
	});

	test("returns 'download' when showRun is false", () => {
		expect(getOllamaPrimaryAction(false)).toBe("download");
	});
});

describe("getOllamaPrimaryLabelKey", () => {
	test("returns 'starting' when showRun=true and starting=true", () => {
		expect(getOllamaPrimaryLabelKey(true, true)).toBe("starting");
	});

	test("returns 'runOllama' when showRun=true and starting=false", () => {
		expect(getOllamaPrimaryLabelKey(true, false)).toBe("runOllama");
	});

	test("returns 'downloadOllama' when showRun=false", () => {
		expect(getOllamaPrimaryLabelKey(false, false)).toBe("downloadOllama");
		expect(getOllamaPrimaryLabelKey(false, true)).toBe("downloadOllama");
	});
});

describe("buildOllamaStartError", () => {
	test("uses the provided error message when present", () => {
		const result = buildOllamaStartError(
			"connection refused",
			"ollamaStartFailed",
		);
		expect(result.errorMessage).toBe("connection refused");
		expect(result.started).toBe(false);
	});

	test("falls back to the translation key when error is undefined", () => {
		const result = buildOllamaStartError(undefined, "ollamaStartFailed");
		expect(result.errorMessage).toBe("ollamaStartFailed");
		expect(result.started).toBe(false);
	});
});

describe("applyOllamaModelReplacementIfNeeded", () => {
	const models = [{ name: "phi" }];

	test("calls update with replacement when shouldSync returns a model name", () => {
		const shouldSync = mock(() => "phi");
		const update = mock(() => undefined);
		applyOllamaModelReplacementIfNeeded(
			"ollama",
			models,
			"missing",
			shouldSync,
			update,
		);
		expect(update).toHaveBeenCalledWith({ model: "phi" });
	});

	test("does not call update when shouldSync returns null", () => {
		const shouldSync = mock(() => null);
		const update = mock(() => undefined);
		applyOllamaModelReplacementIfNeeded(
			"ollama",
			models,
			"phi",
			shouldSync,
			update,
		);
		expect(update).not.toHaveBeenCalled();
	});

	test("passes provider, models, and current to shouldSync", () => {
		const shouldSync = mock(() => null);
		const update = mock(() => undefined);
		applyOllamaModelReplacementIfNeeded(
			"ollama",
			models,
			"current-model",
			shouldSync,
			update,
		);
		expect(shouldSync).toHaveBeenCalledWith("ollama", models, "current-model");
	});
});

describe("ollamaModelSyncNeeded", () => {
	const models = [{ name: "llama3" }];
	const prev = { provider: "ollama", models };

	test("returns false when provider and models are unchanged", () => {
		expect(ollamaModelSyncNeeded(prev, "ollama", models)).toBe(false);
	});

	test("returns true when provider changed", () => {
		expect(ollamaModelSyncNeeded(prev, "openrouter", models)).toBe(true);
	});

	test("returns true when models array reference changed", () => {
		const newModels = [{ name: "llama3" }];
		expect(ollamaModelSyncNeeded(prev, "ollama", newModels)).toBe(true);
	});

	test("returns true when both provider and models changed", () => {
		expect(ollamaModelSyncNeeded(prev, "openrouter", [])).toBe(true);
	});
});

describe("pickNearestOllamaModel", () => {
	test("returns null when no models are installed", () => {
		expect(pickNearestOllamaModel([], "llama3.2:3b")).toBeNull();
	});

	test("prefers a model of the same family over an unrelated one", () => {
		const models = [{ name: "phi3:mini" }, { name: "llama3.2:1b" }];
		expect(pickNearestOllamaModel(models, "llama3.2:3b")).toBe("llama3.2:1b");
	});

	test("falls back to the longest shared prefix across families", () => {
		const models = [{ name: "phi3:mini" }, { name: "qwen3.5:1.7b" }];
		expect(pickNearestOllamaModel(models, "qwen3.5:0.8b")).toBe("qwen3.5:1.7b");
	});

	test("breaks ties by list order (first install wins)", () => {
		const models = [{ name: "gemma4:e2b" }, { name: "smollm2:135m" }];
		expect(pickNearestOllamaModel(models, "unrelated:model")).toBe(
			"gemma4:e2b",
		);
	});
});

describe("resolvePlaygroundLocalModel", () => {
	test("returns null when nothing is installed", () => {
		expect(resolvePlaygroundLocalModel([], "")).toBeNull();
		expect(resolvePlaygroundLocalModel([], "llama3.2:3b")).toBeNull();
	});

	test("defaults to the first install when nothing is selected", () => {
		const models = [{ name: "llama3.2:1b" }, { name: "phi3:mini" }];
		expect(resolvePlaygroundLocalModel(models, "")).toBe("llama3.2:1b");
		expect(resolvePlaygroundLocalModel(models, "   ")).toBe("llama3.2:1b");
	});

	test("keeps a previously-selected model that is still installed", () => {
		const models = [{ name: "llama3.2:1b" }, { name: "phi3:mini" }];
		expect(resolvePlaygroundLocalModel(models, "phi3:mini")).toBeNull();
	});

	test("treats a bare tag as installed when the scan reports :latest", () => {
		const models = [{ name: "tinyllama:latest" }];
		expect(resolvePlaygroundLocalModel(models, "tinyllama")).toBeNull();
	});

	test("swaps a deleted selection for the nearest install", () => {
		const models = [{ name: "phi3:mini" }, { name: "llama3.2:1b" }];
		expect(resolvePlaygroundLocalModel(models, "llama3.2:3b")).toBe(
			"llama3.2:1b",
		);
	});
});

describe("readInputValue", () => {
	test("returns the element value when element is present", () => {
		const input = { value: "test-key" } as HTMLInputElement;
		expect(readInputValue(input)).toBe("test-key");
	});

	test("returns empty string when element is null", () => {
		expect(readInputValue(null)).toBe("");
	});

	test("returns empty string when element is undefined", () => {
		expect(readInputValue(undefined)).toBe("");
	});

	test("returns empty string for an empty input", () => {
		const input = { value: "" } as HTMLInputElement;
		expect(readInputValue(input)).toBe("");
	});
});

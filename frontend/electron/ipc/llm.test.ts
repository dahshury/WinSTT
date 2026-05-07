import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const noop = () => undefined;

// Stub electron + electron-bound modules so importing llm.ts doesn't pull in the real Electron runtime.
mock.module("electron", () => ({
	ipcMain: {
		handle: noop,
		removeHandler: noop,
	},
	app: { getPath: () => "." },
}));
mock.module("../lib/debug-log", () => ({ dbg: noop }));
mock.module("../lib/store", () => ({
	getStoreValue: (key: string) => {
		if (key === "llm.endpoint") {
			return "http://localhost:65535";
		}
		if (key === "llm.timeout") {
			return 5000;
		}
		return undefined;
	},
}));

const { scanOllamaModels } = await import("./llm");

const ENDPOINT = "http://localhost:65535";

describe("scanOllamaModels — connection failure handling", () => {
	const originalFetch = globalThis.fetch;
	let consoleErrorSpy: ReturnType<typeof mock>;
	let originalConsoleError: typeof console.error;

	beforeEach(() => {
		originalConsoleError = console.error;
		consoleErrorSpy = mock(noop);
		console.error = consoleErrorSpy;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		console.error = originalConsoleError;
	});

	test("returns reachable=false with error message when fetch rejects (Ollama not running)", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new TypeError("fetch failed"))
		) as unknown as typeof fetch;

		const result = await scanOllamaModels(ENDPOINT);

		expect(result.models).toEqual([]);
		expect(result.reachable).toBe(false);
		expect(result.error).toBeDefined();
		expect(consoleErrorSpy).not.toHaveBeenCalled();
	});

	test("returns reachable=true with error when Ollama answers with HTTP error", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Service Unavailable", { status: 503 }))
		) as unknown as typeof fetch;

		const result = await scanOllamaModels(ENDPOINT);

		expect(result.models).toEqual([]);
		expect(result.reachable).toBe(true);
		expect(result.error).toContain("503");
		expect(consoleErrorSpy).not.toHaveBeenCalled();
	});

	test("returns reachable=true with parsed models on success", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						models: [{ name: "llama3", size: 4_000_000_000, modified_at: "2026-01-01" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				)
			)
		) as unknown as typeof fetch;

		const result = await scanOllamaModels(ENDPOINT);

		expect(result.reachable).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.models).toEqual([
			{ name: "llama3", size: 4_000_000_000, modifiedAt: "2026-01-01" },
		]);
	});

	test("throws ValidationError for empty endpoint (caller bug — not a connection failure)", async () => {
		await expect(scanOllamaModels("")).rejects.toThrow();
	});
});

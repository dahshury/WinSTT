import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	clearTranscriptionHistory,
	deleteTranscriptionHistoryEntry,
	diagSaveBundle,
} from "./history-files";

type TauriInternals = {
	invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
};

const internals = () =>
	(window as unknown as { __TAURI_INTERNALS__: TauriInternals })
		.__TAURI_INTERNALS__;

let savedInvoke: TauriInternals["invoke"];

beforeEach(() => {
	savedInvoke = internals().invoke;
});

afterEach(() => {
	internals().invoke = savedInvoke;
});

describe("strict destructive and diagnostics commands", () => {
	test("rejects a clear response that did not clear", async () => {
		internals().invoke = () => Promise.resolve({ cleared: false });

		await expect(clearTranscriptionHistory()).rejects.toThrow(
			"did not clear history",
		);
	});

	test("preserves a native delete failure instead of returning a fallback", async () => {
		internals().invoke = () =>
			Promise.reject(new Error("history db is locked"));

		await expect(deleteTranscriptionHistoryEntry("42")).rejects.toThrow(
			"history db is locked",
		);
	});

	test("preserves diagnostic bundle command failures", async () => {
		internals().invoke = () => Promise.reject(new Error("bundle write failed"));

		await expect(diagSaveBundle()).rejects.toThrow("bundle write failed");
	});
});

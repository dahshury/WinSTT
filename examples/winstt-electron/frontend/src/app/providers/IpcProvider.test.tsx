import { describe, expect, test } from "bun:test";
import { IpcProvider } from "./IpcProvider";

describe("IpcProvider", () => {
	test("module exports the provider as a function", () => {
		// IpcProvider orchestrates ~9 hooks against window.electronAPI;
		// fully rendering it under happy-dom requires mocking AudioContext,
		// MediaSource, and racing with gpuGetInfo() — the integration is
		// covered end-to-end by Playwright (phase 10).
		expect(typeof IpcProvider).toBe("function");
	});
});

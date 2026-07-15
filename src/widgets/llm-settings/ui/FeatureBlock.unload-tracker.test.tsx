import { describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { IPC } from "@test/mocks/legacy-ipc";
import type { LlmProvider } from "./types";
import { resolveUnloadPending } from "./feature-block-helpers";
import { useOllamaUnloadTracker } from "./FeatureBlock";

/** Instrument the preload-installed bridge so tests can push backend events.
 *  The preload's afterEach reinstalls the default bridge, so no restore needed. */
function installCapturingBridge() {
	const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	window.nativeBridge = {
		...window.nativeBridge,
		on: (channel: string, callback: (...args: unknown[]) => void) => {
			const arr = listeners.get(channel) ?? [];
			arr.push(callback);
			listeners.set(channel, arr);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((cb) => cb !== callback),
				);
			};
		},
	};
	return {
		emit(channel: string, payload: unknown): void {
			for (const cb of listeners.get(channel) ?? []) {
				cb(payload);
			}
		},
	};
}

function unloadStatus(inProgress: boolean, models: string[]) {
	return {
		endpoint: "http://localhost:11434",
		inProgress,
		models,
		timestamp: 1,
	};
}

describe("resolveUnloadPending", () => {
	test("pending only while armed, ollama, and disabled", () => {
		expect(resolveUnloadPending("gemma3:4b", "ollama", false)).toBe(true);
		expect(resolveUnloadPending(null, "ollama", false)).toBe(false);
		// Re-enable hands off to the warm tracker.
		expect(resolveUnloadPending("gemma3:4b", "ollama", true)).toBe(false);
		expect(resolveUnloadPending("gemma3:4b", "openrouter", false)).toBe(false);
	});
});

describe("useOllamaUnloadTracker", () => {
	test("disable arms the indicator; the terminal unload broadcast settles it", () => {
		const bridge = installCapturingBridge();
		const { result } = renderHook(() =>
			useOllamaUnloadTracker({ enabled: false, provider: "ollama" }),
		);
		expect(result.current.isUnloading).toBe(false);

		act(() => result.current.beginUnload("gemma3:4b"));
		expect(result.current.isUnloading).toBe(true);

		// Batch start keeps it pending…
		act(() => {
			bridge.emit(IPC.LLM_UNLOAD_STATUS, unloadStatus(true, ["gemma3:4b"]));
		});
		expect(result.current.isUnloading).toBe(true);

		// …and only the terminal broadcast covering the model clears it.
		act(() => {
			bridge.emit(IPC.LLM_UNLOAD_STATUS, unloadStatus(false, ["gemma3:4b"]));
		});
		expect(result.current.isUnloading).toBe(false);
	});

	test("a terminal broadcast for a DIFFERENT model does not settle it", () => {
		const bridge = installCapturingBridge();
		const { result } = renderHook(() =>
			useOllamaUnloadTracker({ enabled: false, provider: "ollama" }),
		);
		act(() => result.current.beginUnload("gemma3:4b"));

		act(() => {
			bridge.emit(IPC.LLM_UNLOAD_STATUS, unloadStatus(false, ["qwen3:8b"]));
		});
		expect(result.current.isUnloading).toBe(true);
	});

	test("re-enabling mid-unload hides the indicator (warm tracker takes over)", () => {
		installCapturingBridge();
		const { result, rerender } = renderHook(
			({ enabled }: { enabled: boolean }) =>
				useOllamaUnloadTracker({ enabled, provider: "ollama" }),
			{ initialProps: { enabled: false } },
		);
		act(() => result.current.beginUnload("gemma3:4b"));
		expect(result.current.isUnloading).toBe(true);

		rerender({ enabled: true });
		expect(result.current.isUnloading).toBe(false);
	});

	test("never arms for non-Ollama providers or an empty model", () => {
		installCapturingBridge();
		const { result: openrouter } = renderHook(() =>
			useOllamaUnloadTracker({
				enabled: false,
				provider: "openrouter" as LlmProvider,
			}),
		);
		act(() => openrouter.current.beginUnload("gemma3:4b"));
		expect(openrouter.current.isUnloading).toBe(false);

		const { result: blank } = renderHook(() =>
			useOllamaUnloadTracker({ enabled: false, provider: "ollama" }),
		);
		act(() => blank.current.beginUnload("   "));
		expect(blank.current.isUnloading).toBe(false);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { IPC } from "@/shared/api/ipc-channels";
import { useTranscriptionHistoryStore } from "../model/history-store";
import { useTranscriptionHistorySync } from "./use-history-sync";

const originalApi = window.nativeBridge;
const originalTauriInternals = (
	window as unknown as {
		__TAURI_INTERNALS__?: {
			invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
			transformCallback: (cb?: (payload: unknown) => void, once?: boolean) => number;
		};
	}
).__TAURI_INTERNALS__;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
let invokeImpl: (channel: string) => Promise<unknown> = () => Promise.resolve([]);

beforeEach(() => {
	listeners.clear();
	invokeImpl = () => Promise.resolve([]);
	useTranscriptionHistoryStore.setState({ entries: [], isLoaded: false });
	window.nativeBridge = {
		...originalApi,
		invoke: (channel: string) => invokeImpl(channel),
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb)
				);
			};
		},
	};
	(
		window as unknown as {
			__TAURI_INTERNALS__: NonNullable<typeof originalTauriInternals>;
		}
	).__TAURI_INTERNALS__ = {
		...(originalTauriInternals ?? {
			transformCallback: () => 0,
		}),
		invoke: (cmd: string) => invokeImpl(cmd),
	};
});

afterEach(() => {
	window.nativeBridge = originalApi;
	if (originalTauriInternals) {
		(
			window as unknown as {
				__TAURI_INTERNALS__: typeof originalTauriInternals;
			}
		).__TAURI_INTERNALS__ = originalTauriInternals;
	}
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

describe("useTranscriptionHistorySync", () => {
	test("subscribes to history:added on mount", () => {
		renderHook(() => useTranscriptionHistorySync());
		expect(listeners.has(IPC.HISTORY_ADDED)).toBe(true);
	});

	test("hydrates the store from history:get-all on mount", async () => {
		invokeImpl = () =>
			Promise.resolve([{ id: "a", timestamp: 1, text: "hi", wordCount: 1, durationMs: 1000 }]);
		renderHook(() => useTranscriptionHistorySync());
		await waitFor(() => {
			expect(useTranscriptionHistoryStore.getState().isLoaded).toBe(true);
		});
		expect(useTranscriptionHistoryStore.getState().entries.map((e) => e.id)).toEqual(["a"]);
	});

	test("appends entries broadcast on history:added", () => {
		renderHook(() => useTranscriptionHistorySync());
		act(() => {
			fire(IPC.HISTORY_ADDED, {
				id: "b",
				timestamp: 2,
				text: "yo",
				wordCount: 1,
				durationMs: 800,
			});
		});
		expect(useTranscriptionHistoryStore.getState().entries.map((e) => e.id)).toEqual(["b"]);
	});

	test("unmount removes the history:added listener", () => {
		const { unmount } = renderHook(() => useTranscriptionHistorySync());
		unmount();
		expect(listeners.get(IPC.HISTORY_ADDED)?.length ?? 0).toBe(0);
	});

	test("late-arriving fetch result is dropped after unmount (no setState on unmounted component)", async () => {
		// Set up a fetch promise the test can resolve manually.
		let resolveFetch: (value: unknown[]) => void = () => {
			/* overwritten below before being called */
		};
		invokeImpl = () =>
			new Promise<unknown[]>((resolve) => {
				resolveFetch = resolve;
			});

		const { unmount } = renderHook(() => useTranscriptionHistorySync());
		unmount();
		// Resolve AFTER unmount — the cancelled guard must prevent setAll.
		resolveFetch([{ id: "late", timestamp: 1, text: "x", wordCount: 1, durationMs: 1000 }]);
		await Promise.resolve();
		expect(useTranscriptionHistoryStore.getState().entries).toEqual([]);
		expect(useTranscriptionHistoryStore.getState().isLoaded).toBe(false);
	});
});

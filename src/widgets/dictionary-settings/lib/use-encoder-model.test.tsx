import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { EncoderDownloadStatus } from "@/bindings";
import { NATIVE_EVENTS } from "@/shared/api/native-events";
import { useEncoderModel } from "./use-encoder-model";

type TauriWindow = Window & {
	__TAURI_INTERNALS__?: {
		invoke: (command: string, args?: unknown) => Promise<unknown>;
		transformCallback: (callback?: (payload: unknown) => void) => number;
	};
};

const ABSENT_STATUS: EncoderDownloadStatus = {
	downloadedBytes: 0,
	error: null,
	progress: 0,
	speedBps: 0,
	state: "absent",
	totalBytes: 0,
};

describe("useEncoderModel", () => {
	test("does not touch native APIs without a native runtime", async () => {
		const nativeWindow = window as TauriWindow;
		const originalBridge = window.nativeBridge;
		const originalInternals = nativeWindow.__TAURI_INTERNALS__;
		const consoleError = console.error;
		const errors = mock(() => undefined);
		Reflect.deleteProperty(window, "nativeBridge");
		Reflect.deleteProperty(nativeWindow, "__TAURI_INTERNALS__");
		console.error = errors;

		try {
			const { result } = renderHook(() => useEncoderModel());
			await act(async () => {
				await Promise.resolve();
			});
			expect(result.current.state).toBe("absent");
			expect(result.current.error).toBeNull();
			expect(errors).not.toHaveBeenCalled();
		} finally {
			window.nativeBridge = originalBridge;
			if (originalInternals === undefined) {
				Reflect.deleteProperty(nativeWindow, "__TAURI_INTERNALS__");
			} else {
				nativeWindow.__TAURI_INTERNALS__ = originalInternals;
			}
			console.error = consoleError;
		}
	});

	test("surfaces command and native model-load failures", async () => {
		const nativeWindow = window as TauriWindow;
		const originalBridge = window.nativeBridge;
		const originalInvoke = nativeWindow.__TAURI_INTERNALS__?.invoke;
		const originalConsoleError = console.error;
		const listeners = new Map<string, (...args: unknown[]) => void>();
		window.nativeBridge = {
			...originalBridge,
			on: (channel, callback) => {
				listeners.set(channel, callback);
				return () => listeners.delete(channel);
			},
		};
		if (!(nativeWindow.__TAURI_INTERNALS__ && originalInvoke)) {
			throw new Error("Tauri test internals are unavailable");
		}
		nativeWindow.__TAURI_INTERNALS__.invoke = async (command) => {
			if (command === "encoder_dict_status") {
				return ABSENT_STATUS;
			}
			if (command === "encoder_dict_download_start") {
				throw new Error("network unavailable");
			}
			return null;
		};
		console.error = mock(() => undefined);

		try {
			const { result } = renderHook(() => useEncoderModel());
			await waitFor(() => expect(result.current.state).toBe("absent"));
			act(() => result.current.start());
			await waitFor(() =>
				expect(result.current.error).toBe("network unavailable"),
			);

			act(() => {
				listeners.get(NATIVE_EVENTS.ENCODER_DICT_MODEL_ERROR)?.({
					error: "model failed to load",
				});
			});
			expect(result.current.error).toBe("model failed to load");
		} finally {
			window.nativeBridge = originalBridge;
			nativeWindow.__TAURI_INTERNALS__.invoke = originalInvoke;
			console.error = originalConsoleError;
		}
	});
});

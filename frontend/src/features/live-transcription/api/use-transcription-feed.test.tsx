import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useTranscriptionStore } from "@/entities/transcription";
import { IPC } from "@/shared/api/ipc-channels";
import { useTranscriptionFeed } from "./use-transcription-feed";

const originalApi = window.electronAPI;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

beforeEach(() => {
	listeners.clear();
	useTranscriptionStore.setState({ items: [], currentRealtime: "", ephemeral: null });
	window.electronAPI = {
		...originalApi,
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
});

afterEach(() => {
	window.electronAPI = originalApi;
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

describe("useTranscriptionFeed", () => {
	test("subscribes to realtime/full-sentence/no-audio channels", () => {
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		expect(listeners.has(IPC.STT_REALTIME_TEXT)).toBe(true);
		expect(listeners.has(IPC.STT_FULL_SENTENCE)).toBe(true);
		expect(listeners.has(IPC.STT_NO_AUDIO_DETECTED)).toBe(true);
	});

	test("realtime text updates currentRealtime in the store", () => {
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_REALTIME_TEXT, { text: "preview" });
		expect(useTranscriptionStore.getState().currentRealtime).toBe("preview");
	});

	test("full sentence appends to items", () => {
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_FULL_SENTENCE, { text: "Hello." });
		expect(useTranscriptionStore.getState().items).toHaveLength(1);
		expect(useTranscriptionStore.getState().items[0]?.text).toBe("Hello.");
	});

	test("no-audio shows an ephemeral message", () => {
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_NO_AUDIO_DETECTED);
		expect(useTranscriptionStore.getState().ephemeral).not.toBeNull();
	});
});

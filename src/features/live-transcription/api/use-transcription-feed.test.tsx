import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useTranscriptionStore } from "@/entities/transcription";
import { IPC } from "@/shared/api/ipc-channels";
import { useTranscriptionFeed } from "./use-transcription-feed";

const originalApi = window.nativeBridge;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

beforeEach(() => {
	listeners.clear();
	useTranscriptionStore.setState({
		items: [],
		currentRealtime: "",
		ephemeral: null,
		isRecordingActive: false,
	});
	window.nativeBridge = {
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
	window.nativeBridge = originalApi;
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

	test("transcription_failed shows an honest ephemeral message (not 'no audio')", () => {
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		expect(listeners.has(IPC.STT_TRANSCRIPTION_FAILED)).toBe(true);
		fire(IPC.STT_TRANSCRIPTION_FAILED);
		const ephemeral = useTranscriptionStore.getState().ephemeral;
		expect(ephemeral).not.toBeNull();
		// The pill must say something *other* than the no-audio copy — that's
		// the whole point of the fix (don't lie when the backend errored).
		expect(ephemeral?.text).not.toBe("(no audio detected)");
		expect(ephemeral?.text).toContain("transcription");
	});

	test("transcription_failed disarms isRecordingActive (terminal event)", () => {
		useTranscriptionStore.setState({ isRecordingActive: true });
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_TRANSCRIPTION_FAILED);
		expect(useTranscriptionStore.getState().isRecordingActive).toBe(false);
	});

	test("recording_start clears stale state and arms isRecordingActive", () => {
		// Prime the store with a previous session's text (and a stale ephemeral
		// from a prior no_audio_detected) so we can verify recording_start wipes
		// them before the pill could possibly paint them — same race the bug
		// report describes ("flashes previous transcription on next PTT press").
		useTranscriptionStore.setState({
			currentRealtime: "leftover from last press",
			ephemeral: { text: "no audio detected", timestamp: 0 },
			isRecordingActive: false,
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_START);
		const state = useTranscriptionStore.getState();
		expect(state.currentRealtime).toBe("");
		expect(state.ephemeral).toBeNull();
		expect(state.isRecordingActive).toBe(true);
	});

	test("full_sentence disarms isRecordingActive (terminal event)", () => {
		useTranscriptionStore.setState({ isRecordingActive: true });
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_FULL_SENTENCE, { text: "done." });
		expect(useTranscriptionStore.getState().isRecordingActive).toBe(false);
	});

	test("no_audio_detected disarms isRecordingActive (terminal event)", () => {
		useTranscriptionStore.setState({ isRecordingActive: true });
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_NO_AUDIO_DETECTED);
		expect(useTranscriptionStore.getState().isRecordingActive).toBe(false);
	});

	test("recording_stop disarms isRecordingActive (pill survives LLM thinking via isThinking, not this flag)", () => {
		// The pill's mount gate is `isRecordingActive || isThinking`. The
		// transcription feed OWNS `isRecordingActive` and disarms it the instant
		// the PTT key is released (recording_stop), like Handy — the pill is the
		// recording indicator, not the transcribe/post-process indicator. When an
		// Ollama/LLM post-processor is connected the SEPARATE `isThinking` flag
		// (driven by LLM_PROCESSING_START/_END) keeps the pill visible across the
		// recording → thinking transition, so disarming here causes no flicker.
		// recording_stop also wipes the realtime/ephemeral preview so it can't
		// survive into the next PTT session.
		useTranscriptionStore.setState({
			isRecordingActive: true,
			currentRealtime: "live preview",
			ephemeral: { text: "stale", timestamp: 0 },
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_STOP);
		const state = useTranscriptionStore.getState();
		expect(state.isRecordingActive).toBe(false);
		expect(state.currentRealtime).toBe("");
		expect(state.ephemeral).toBeNull();
	});
});

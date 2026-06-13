import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { IPC } from "@/shared/api/ipc-channels";
import { useTranscriptionFeed } from "./use-transcription-feed";

const originalApi = window.nativeBridge;
const initialSettings = useSettingsStore.getState().settings;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

beforeEach(() => {
	listeners.clear();
	useSettingsStore.setState({ settings: initialSettings });
	useTranscriptionStore.setState({
		items: [],
		currentRealtime: "",
		ephemeral: null,
		isRecordingActive: false,
		isTranscribing: false,
		processingPhase: null,
		recordingSessionId: 0,
		transcribingStartedAt: null,
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
					(listeners.get(channel) ?? []).filter((x) => x !== cb),
				);
			};
		},
	};
});

afterEach(() => {
	window.nativeBridge = originalApi;
	useSettingsStore.setState({ settings: initialSettings });
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

function setRecordingMode(
	recordingMode: "ptt" | "toggle" | "listen" | "wakeword",
) {
	useSettingsStore.setState({
		settings: {
			...initialSettings,
			general: {
				...initialSettings.general,
				recordingMode,
			},
		},
	});
}

function withImmediateTimeout(run: () => void) {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) => {
		if (typeof handler === "function") {
			handler();
		}
		return 0 as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
	try {
		run();
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
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
		expect(listeners.has(IPC.STT_RECORDING_STOP)).toBe(true);
		expect(listeners.has(IPC.STT_TRANSCRIPTION_START)).toBe(true);
		expect(listeners.has(IPC.STT_VAD_START)).toBe(true);
	});

	test("realtime text updates currentRealtime in the store", () => {
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_REALTIME_TEXT, { text: "preview" });
		expect(useTranscriptionStore.getState().currentRealtime).toBe("preview");
	});

	test("empty realtime drops do not erase visible live text during an active recording", () => {
		useTranscriptionStore.setState({
			isRecordingActive: true,
			currentRealtime: "",
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_REALTIME_TEXT, { text: "first words" });
		fire(IPC.STT_REALTIME_TEXT, { text: "" });
		expect(useTranscriptionStore.getState().currentRealtime).toBe(
			"first words",
		);
	});

	test("listen mode accepts empty realtime updates without wiping scrollback", () => {
		setRecordingMode("listen");
		useTranscriptionStore.setState({
			isRecordingActive: true,
			items: [
				{ id: "old", type: "final", text: "old listen row", timestamp: 1 },
			],
			currentRealtime: "speaker caption",
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_REALTIME_TEXT, { text: "" });
		expect(useTranscriptionStore.getState().currentRealtime).toBe("");
		expect(useTranscriptionStore.getState().items.map((i) => i.text)).toEqual([
			"old listen row",
		]);
	});

	test("listen mode keeps finalized rows when new realtime text appears", () => {
		setRecordingMode("listen");
		useTranscriptionStore.setState({
			isRecordingActive: true,
			items: [
				{ id: "old", type: "final", text: "old listen row", timestamp: 1 },
			],
			currentRealtime: "",
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_REALTIME_TEXT, { text: "new caption" });
		expect(useTranscriptionStore.getState().currentRealtime).toBe(
			"new caption",
		);
		expect(useTranscriptionStore.getState().items.map((i) => i.text)).toEqual([
			"old listen row",
		]);
	});

	test("listen mode recording_start arms capture without wiping visible captions", () => {
		setRecordingMode("listen");
		useTranscriptionStore.setState({
			isRecordingActive: false,
			isTranscribing: true,
			items: [
				{
					id: "old",
					type: "final",
					text: "still visible listen row",
					timestamp: 1,
				},
			],
			currentRealtime: "live listen words",
			ephemeral: { text: "status", timestamp: 1 },
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_START);
		const state = useTranscriptionStore.getState();
		expect(state.isRecordingActive).toBe(true);
		expect(state.isTranscribing).toBe(true);
		expect(state.items.map((i) => i.text)).toEqual([
			"still visible listen row",
		]);
		expect(state.currentRealtime).toBe("live listen words");
		expect(state.ephemeral?.text).toBe("status");
	});

	test("listen mode vad_start does not wipe the in-flight caption", () => {
		setRecordingMode("listen");
		useTranscriptionStore.setState({
			isRecordingActive: true,
			items: [
				{
					id: "old",
					type: "final",
					text: "visible finalized row",
					timestamp: 1,
				},
			],
			currentRealtime: "words still forming",
			ephemeral: { text: "status", timestamp: 1 },
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_VAD_START);
		const state = useTranscriptionStore.getState();
		expect(state.items.map((i) => i.text)).toEqual(["visible finalized row"]);
		expect(state.currentRealtime).toBe("words still forming");
		expect(state.ephemeral).toBeNull();
	});

	test("full sentence appends to items", () => {
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_FULL_SENTENCE, { text: "Hello." });
		expect(useTranscriptionStore.getState().items).toHaveLength(1);
		expect(useTranscriptionStore.getState().items[0]?.text).toBe("Hello.");
	});

	test("completed non-listen sessions clear their finalized caption rows", () => {
		setRecordingMode("ptt");
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_START);

		withImmediateTimeout(() => {
			fire(IPC.STT_FULL_SENTENCE, { text: "done." });
		});

		expect(useTranscriptionStore.getState().items).toEqual([]);
	});

	test("listen mode keeps finalized rows for active rolling captions", () => {
		setRecordingMode("listen");
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_START);

		withImmediateTimeout(() => {
			fire(IPC.STT_FULL_SENTENCE, { text: "listen row." });
		});

		expect(useTranscriptionStore.getState().items.map((i) => i.text)).toEqual([
			"listen row.",
		]);
		expect(useTranscriptionStore.getState().isRecordingActive).toBe(true);
	});

	test("no-audio clears state without showing an ephemeral message", () => {
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_NO_AUDIO_DETECTED);
		const state = useTranscriptionStore.getState();
		expect(state.ephemeral).toBeNull();
		expect(state.isRecordingActive).toBe(false);
		expect(state.isTranscribing).toBe(false);
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
		useTranscriptionStore.setState({
			isRecordingActive: true,
			isTranscribing: true,
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_TRANSCRIPTION_FAILED);
		expect(useTranscriptionStore.getState().isRecordingActive).toBe(false);
		expect(useTranscriptionStore.getState().isTranscribing).toBe(false);
	});

	test("recording_start clears stale state and arms isRecordingActive", () => {
		// Prime the store with a previous session's text (and a stale ephemeral
		// from a prior no_audio_detected) so we can verify recording_start wipes
		// them before the pill could possibly paint them — same race the bug
		// report describes ("flashes previous transcription on next PTT press").
		useTranscriptionStore.setState({
			items: [
				{
					id: "old-final",
					type: "final",
					text: "old final",
					timestamp: 1,
				},
			],
			currentRealtime: "leftover from last press",
			ephemeral: { text: "no audio detected", timestamp: 0 },
			isRecordingActive: false,
			isTranscribing: true,
			processingPhase: "uploading",
			recordingSessionId: 41,
			transcribingStartedAt: 100,
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_START);
		const state = useTranscriptionStore.getState();
		expect(state.items).toEqual([]);
		expect(state.currentRealtime).toBe("");
		expect(state.ephemeral).toBeNull();
		expect(state.isRecordingActive).toBe(true);
		expect(state.isTranscribing).toBe(false);
		expect(state.processingPhase).toBeNull();
		expect(state.recordingSessionId).toBe(42);
		expect(state.transcribingStartedAt).toBeNull();
	});

	test("transcription_start marks final decode as transcribing after VAD speech", () => {
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_VAD_START);
		fire(IPC.STT_TRANSCRIPTION_START, { audioBase64: undefined });
		const state = useTranscriptionStore.getState();
		expect(state.isTranscribing).toBe(true);
		expect(state.processingPhase).toBe("transcribing");
		expect(typeof state.transcribingStartedAt).toBe("number");
	});

	test("transcription_start is ignored before VAD speech", () => {
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_TRANSCRIPTION_START, { audioBase64: undefined });
		const state = useTranscriptionStore.getState();
		expect(state.isTranscribing).toBe(false);
		expect(state.processingPhase).toBeNull();
		expect(state.transcribingStartedAt).toBeNull();
	});

	test("recording_stop marks final cloud handoff as uploading after audio activity", () => {
		useTranscriptionStore.setState({
			isRecordingActive: true,
			isTranscribing: false,
			processingPhase: null,
			transcribingStartedAt: null,
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_VAD_START);
		fire(IPC.STT_RECORDING_STOP);
		const state = useTranscriptionStore.getState();
		expect(state.isRecordingActive).toBe(true);
		expect(state.isTranscribing).toBe(true);
		expect(state.processingPhase).toBe("uploading");
		expect(typeof state.transcribingStartedAt).toBe("number");
	});

	test("recording_stop does not mark silent sessions as transcribing", () => {
		useTranscriptionStore.setState({
			isRecordingActive: true,
			isTranscribing: false,
			processingPhase: null,
			transcribingStartedAt: null,
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_STOP);
		const state = useTranscriptionStore.getState();
		expect(state.isRecordingActive).toBe(true);
		expect(state.isTranscribing).toBe(false);
		expect(state.processingPhase).toBeNull();
		expect(state.transcribingStartedAt).toBeNull();
	});

	test("recording_stop is ignored when no recording session is active", () => {
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_STOP);
		const state = useTranscriptionStore.getState();
		expect(state.isTranscribing).toBe(false);
		expect(state.processingPhase).toBeNull();
		expect(state.transcribingStartedAt).toBeNull();
	});

	test("full_sentence disarms isRecordingActive (terminal event)", () => {
		useTranscriptionStore.setState({
			isRecordingActive: true,
			isTranscribing: true,
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_FULL_SENTENCE, { text: "done." });
		expect(useTranscriptionStore.getState().isRecordingActive).toBe(false);
		expect(useTranscriptionStore.getState().isTranscribing).toBe(false);
	});

	test("no_audio_detected disarms isRecordingActive (terminal event)", () => {
		useTranscriptionStore.setState({
			isRecordingActive: true,
			isTranscribing: true,
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_NO_AUDIO_DETECTED);
		expect(useTranscriptionStore.getState().isRecordingActive).toBe(false);
		expect(useTranscriptionStore.getState().isTranscribing).toBe(false);
	});

	test("recording_stop preserves the armed session and live text", () => {
		// `recording_stop` arrives before the terminal transcription event. If
		// it closes the floating pill here, the terminal event starts a second
		// close path and the bottom-pill fade-out feels laggy.
		useTranscriptionStore.setState({
			isRecordingActive: true,
			isTranscribing: false,
			currentRealtime: "live preview",
			ephemeral: { text: "stale", timestamp: 0 },
			processingPhase: null,
			transcribingStartedAt: null,
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_VAD_START);
		fire(IPC.STT_REALTIME_TEXT, { text: "live preview" });
		fire(IPC.STT_RECORDING_STOP);
		const state = useTranscriptionStore.getState();
		expect(state.isRecordingActive).toBe(true);
		expect(state.isTranscribing).toBe(true);
		expect(state.processingPhase).toBe("uploading");
		expect(typeof state.transcribingStartedAt).toBe("number");
		expect(state.currentRealtime).toBe("live preview");
		expect(state.ephemeral?.text).toBe("stale");
	});
});

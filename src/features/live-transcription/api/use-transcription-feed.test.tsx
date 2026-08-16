import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { IPC } from "@test/mocks/legacy-ipc";
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
		hasDetectedSpeech: false,
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
	// Without this, a `renderHook` instance from an earlier test stays mounted
	// (its effects and store subscriptions still live) into later tests. That
	// used to be harmless here, but the mode-boundary reset effect below now
	// reacts to `useSettingsStore` changes -- a later test's `setRecordingMode`
	// call would replay that reset against a stale instance's leftover
	// `prevRecordingModeRef`, mutating the shared `useTranscriptionStore` out
	// from under the test that's actually running.
	cleanup();
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
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = (() => undefined) as unknown as typeof clearTimeout;
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
			ephemeral: { kind: "info", text: "status", timestamp: 1 },
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_START);
		const state = useTranscriptionStore.getState();
		expect(state.isRecordingActive).toBe(true);
		expect(state.hasDetectedSpeech).toBe(false);
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
			ephemeral: { kind: "info", text: "status", timestamp: 1 },
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_VAD_START);
		expect(useTranscriptionStore.getState().hasDetectedSpeech).toBe(true);
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
			ephemeral: { kind: "info", text: "no audio detected", timestamp: 0 },
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

	test("a late recording_start does not erase speech recovered from the backend snapshot", () => {
		useTranscriptionStore.setState({
			isRecordingActive: true,
			hasDetectedSpeech: true,
			recordingSessionId: 7,
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_START);
		const state = useTranscriptionStore.getState();
		expect(state.recordingSessionId).toBe(7);
		expect(state.hasDetectedSpeech).toBe(true);
	});

	test("recording_start during a still-winding-down session wipes the previous take's text", () => {
		// Quick re-press: the previous session's full_sentence hasn't landed yet
		// (final decode / LLM cleanup still running), so `isRecordingActive` is
		// still armed and the full session reset is skipped. The stale realtime
		// text must NOT survive into the new take — it painted the previous
		// transcription into the pill the moment the user started talking again.
		useTranscriptionStore.setState({
			isRecordingActive: true,
			hasDetectedSpeech: true,
			recordingSessionId: 7,
			currentRealtime: "previous take's words",
			ephemeral: { kind: "info", text: "stale status", timestamp: 1 },
			isTranscribing: true,
			processingPhase: "transcribing",
			transcribingStartedAt: 100,
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_START);
		const state = useTranscriptionStore.getState();
		// Session identity + recovered speech latch are preserved…
		expect(state.recordingSessionId).toBe(7);
		expect(state.hasDetectedSpeech).toBe(true);
		expect(state.isRecordingActive).toBe(true);
		// …but every piece of stale per-take text/processing state is wiped.
		expect(state.currentRealtime).toBe("");
		expect(state.ephemeral).toBeNull();
		expect(state.isTranscribing).toBe(false);
		expect(state.processingPhase).toBeNull();
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

	test("recording_stop wipes the live realtime preview (non-listen)", () => {
		useTranscriptionStore.setState({
			isRecordingActive: true,
			currentRealtime: "words painted during the take",
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_STOP);
		expect(useTranscriptionStore.getState().currentRealtime).toBe("");
	});

	test("listen mode recording_stop keeps the in-flight caption", () => {
		setRecordingMode("listen");
		useTranscriptionStore.setState({
			isRecordingActive: true,
			currentRealtime: "rolling caption",
		});
		renderHook(() => useTranscriptionFeed(), {
			wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
		});
		fire(IPC.STT_RECORDING_STOP);
		expect(useTranscriptionStore.getState().currentRealtime).toBe(
			"rolling caption",
		);
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

	test("recording_stop preserves the armed session but drops the live text", () => {
		// `recording_stop` arrives before the terminal transcription event. If
		// it closes the floating pill here, the terminal event starts a second
		// close path and the bottom-pill fade-out feels laggy — so the SESSION
		// stays armed. The live realtime text, however, is invalidated at the
		// recording boundary: the pill hides it behind the processing spinner
		// from here anyway, and keeping it around let a quick re-press resurface
		// the previous take's transcription in the next session's pill.
		useTranscriptionStore.setState({
			isRecordingActive: true,
			isTranscribing: false,
			currentRealtime: "live preview",
			ephemeral: { kind: "info", text: "stale", timestamp: 0 },
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
		expect(state.currentRealtime).toBe("");
		expect(state.ephemeral?.text).toBe("stale");
	});

	describe("recording mode change", () => {
		test("switching away from listen mode clears isRecordingActive and the pill state", () => {
			// Listen mode is continuous: its `recording_start` only latches
			// `isRecordingActive` and nothing ever fires a terminal event
			// (full_sentence/no_audio_detected/etc.) to release it. Switching
			// modes today emits no recording-lifecycle IPC event either, so
			// without a mode-change reset this state carries over and the
			// overlay pill stays stuck revealed after leaving listen mode.
			setRecordingMode("listen");
			useTranscriptionStore.setState({
				isRecordingActive: true,
				isTranscribing: true,
				processingPhase: "transcribing",
				currentRealtime: "live listen caption",
				ephemeral: { kind: "info", text: "status", timestamp: 1 },
			});
			renderHook(() => useTranscriptionFeed(), {
				wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
			});

			act(() => setRecordingMode("ptt"));

			const state = useTranscriptionStore.getState();
			expect(state.isRecordingActive).toBe(false);
			expect(state.isTranscribing).toBe(false);
			expect(state.processingPhase).toBeNull();
			expect(state.currentRealtime).toBe("");
			expect(state.ephemeral).toBeNull();
		});

		test("switching between two non-listen modes also resets a stale session", () => {
			setRecordingMode("ptt");
			useTranscriptionStore.setState({
				isRecordingActive: true,
				isTranscribing: true,
				currentRealtime: "mid dictation",
			});
			renderHook(() => useTranscriptionFeed(), {
				wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
			});

			act(() => setRecordingMode("toggle"));

			const state = useTranscriptionStore.getState();
			expect(state.isRecordingActive).toBe(false);
			expect(state.isTranscribing).toBe(false);
			expect(state.currentRealtime).toBe("");
		});

		test("mounting the hook does not reset pre-seeded state (no false transition on mount)", () => {
			setRecordingMode("listen");
			useTranscriptionStore.setState({
				isRecordingActive: true,
				currentRealtime: "already live",
			});

			renderHook(() => useTranscriptionFeed(), {
				wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
			});

			const state = useTranscriptionStore.getState();
			expect(state.isRecordingActive).toBe(true);
			expect(state.currentRealtime).toBe("already live");
		});

		test("re-affirming the same recording mode does not reset an active session", () => {
			setRecordingMode("listen");
			renderHook(() => useTranscriptionFeed(), {
				wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
			});
			useTranscriptionStore.setState({
				isRecordingActive: true,
				currentRealtime: "still forming",
			});

			act(() => setRecordingMode("listen"));

			const state = useTranscriptionStore.getState();
			expect(state.isRecordingActive).toBe(true);
			expect(state.currentRealtime).toBe("still forming");
		});
	});
});

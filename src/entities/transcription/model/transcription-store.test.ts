import { beforeEach, describe, expect, test } from "bun:test";
import { useTranscriptionStore } from "./transcription-store";

// IMPORTANT: the "initial state" tests below MUST come BEFORE the beforeEach
// resets the store. Once any test runs setState, the post-create initial state
// is gone. Read it through `getInitialState()` which returns the factory result
// regardless of subsequent mutations.
describe("useTranscriptionStore initial state (factory defaults)", () => {
	test("starts with an empty items array", () => {
		// Locks `items: []` — mutating to a non-empty array would expose the
		// stub default to consumers. Use getInitialState so beforeEach in the
		// other suite can't mask the bug.
		expect(useTranscriptionStore.getInitialState().items).toEqual([]);
	});

	test("starts with an empty currentRealtime string", () => {
		// Locks `currentRealtime: ""` — mutating the literal would surface a
		// "Stryker was here!" string to the live-preview UI on first render.
		expect(useTranscriptionStore.getInitialState().currentRealtime).toBe("");
	});

	test("starts with a null ephemeral message", () => {
		expect(useTranscriptionStore.getInitialState().ephemeral).toBeNull();
	});

	test("starts with isRecordingActive set to false", () => {
		// Locks the default so the overlay pill stays hidden on a fresh
		// renderer mount until a real recording_start event flips this true.
		expect(useTranscriptionStore.getInitialState().isRecordingActive).toBe(false);
	});
});

beforeEach(() => {
	useTranscriptionStore.setState({
		items: [],
		currentRealtime: "",
		ephemeral: null,
		isRecordingActive: false,
	});
});

describe("useTranscriptionStore", () => {
	test("addFinalSentence appends a new final item with id+timestamp and clears realtime", () => {
		useTranscriptionStore.getState().setRealtimeText("typing…");
		useTranscriptionStore.getState().addFinalSentence("Hello world.");
		const state = useTranscriptionStore.getState();
		expect(state.items).toHaveLength(1);
		expect(state.items[0]?.text).toBe("Hello world.");
		expect(state.items[0]?.type).toBe("final");
		expect(typeof state.items[0]?.id).toBe("string");
		expect(typeof state.items[0]?.timestamp).toBe("number");
		expect(state.currentRealtime).toBe("");
	});

	test("subsequent addFinalSentence pushes a new item without dropping previous ones", () => {
		useTranscriptionStore.getState().addFinalSentence("first");
		useTranscriptionStore.getState().addFinalSentence("second");
		const items = useTranscriptionStore.getState().items;
		expect(items.map((i) => i.text)).toEqual(["first", "second"]);
		expect(items[0]?.id).not.toBe(items[1]?.id);
	});

	test("addFinalSentence caps the live feed at 500 items (drops oldest)", () => {
		// Append 501 sentences; the very first one should fall off and the
		// oldest retained entry should be #1, not #0. Without the cap, the
		// feed grows unbounded across a long dictation session — O(N²) total
		// allocation pressure since `addFinalSentence` does `[...items, new]`.
		const total = 501;
		for (let i = 0; i < total; i++) {
			useTranscriptionStore.getState().addFinalSentence(`sentence-${i}`);
		}
		const items = useTranscriptionStore.getState().items;
		expect(items).toHaveLength(500);
		expect(items[0]?.text).toBe("sentence-1");
		expect(items.at(-1)?.text).toBe(`sentence-${total - 1}`);
	});

	test("setRealtimeText replaces the live preview", () => {
		useTranscriptionStore.getState().setRealtimeText("preview");
		expect(useTranscriptionStore.getState().currentRealtime).toBe("preview");
		useTranscriptionStore.getState().setRealtimeText("");
		expect(useTranscriptionStore.getState().currentRealtime).toBe("");
	});

	test("showEphemeral sets a non-null ephemeral with timestamp", () => {
		useTranscriptionStore.getState().showEphemeral("Saved!");
		const eph = useTranscriptionStore.getState().ephemeral;
		expect(eph?.text).toBe("Saved!");
		expect(typeof eph?.timestamp).toBe("number");
	});

	test("clearEphemeral nulls out the ephemeral message", () => {
		useTranscriptionStore.getState().showEphemeral("X");
		useTranscriptionStore.getState().clearEphemeral();
		expect(useTranscriptionStore.getState().ephemeral).toBeNull();
	});

	test("clearAll resets items, realtime, and ephemeral", () => {
		useTranscriptionStore.getState().addFinalSentence("a");
		useTranscriptionStore.getState().setRealtimeText("b");
		useTranscriptionStore.getState().showEphemeral("c");
		useTranscriptionStore.getState().clearAll();
		const state = useTranscriptionStore.getState();
		expect(state.items).toEqual([]);
		expect(state.currentRealtime).toBe("");
		expect(state.ephemeral).toBeNull();
	});

	test("setRecordingActive toggles the isRecordingActive flag", () => {
		useTranscriptionStore.getState().setRecordingActive(true);
		expect(useTranscriptionStore.getState().isRecordingActive).toBe(true);
		useTranscriptionStore.getState().setRecordingActive(false);
		expect(useTranscriptionStore.getState().isRecordingActive).toBe(false);
	});

	test("clearAll also resets isRecordingActive to false", () => {
		useTranscriptionStore.getState().setRecordingActive(true);
		useTranscriptionStore.getState().clearAll();
		expect(useTranscriptionStore.getState().isRecordingActive).toBe(false);
	});

	test("attachSpeakerSegments is a no-op when the live feed is empty", () => {
		// Cold start: no items yet, so the segments push has nothing to attach to.
		// Snapshot the state and assert it didn't mutate (kills the "still calls
		// set with new items" mutation that would dirty an empty feed).
		const before = useTranscriptionStore.getState().items;
		useTranscriptionStore.getState().attachSpeakerSegments([{ start: 0, end: 1, speaker: 0 }]);
		const after = useTranscriptionStore.getState().items;
		expect(after).toBe(before);
		expect(after).toHaveLength(0);
	});

	test("attachSpeakerSegments stamps the segments onto the most recent item only", () => {
		useTranscriptionStore.getState().addFinalSentence("first");
		useTranscriptionStore.getState().addFinalSentence("second");
		const segments = [
			{ start: 0, end: 0.5, speaker: 0 },
			{ start: 0.5, end: 1.2, speaker: 1 },
		];
		useTranscriptionStore.getState().attachSpeakerSegments(segments);
		const items = useTranscriptionStore.getState().items;
		expect(items).toHaveLength(2);
		// Previous item is untouched (no speakerSegments field added).
		expect(items[0]?.speakerSegments).toBeUndefined();
		// Latest item carries the new segments verbatim.
		expect(items[1]?.speakerSegments).toEqual(segments);
		// Text on both is preserved.
		expect(items.map((i) => i.text)).toEqual(["first", "second"]);
	});

	test("attachSpeakerSegments replaces the previous speakerSegments on re-emit", () => {
		// The server can emit speaker_segments more than once per utterance as
		// the diarizer settles; the latest emit should win.
		useTranscriptionStore.getState().addFinalSentence("only");
		useTranscriptionStore.getState().attachSpeakerSegments([{ start: 0, end: 1, speaker: 0 }]);
		useTranscriptionStore.getState().attachSpeakerSegments([{ start: 0, end: 1, speaker: 5 }]);
		const items = useTranscriptionStore.getState().items;
		expect(items[0]?.speakerSegments).toEqual([{ start: 0, end: 1, speaker: 5 }]);
	});
});

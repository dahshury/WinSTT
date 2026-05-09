import { beforeEach, describe, expect, test } from "bun:test";
import { useTranscriptionStore } from "./transcription-store";

beforeEach(() => {
	useTranscriptionStore.setState({ items: [], currentRealtime: "", ephemeral: null });
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
});

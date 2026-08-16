import { afterEach, describe, expect, test } from "bun:test";
import type { SentenceSpan } from "../lib/playback-queue";
import { useTtsScriptStore } from "./tts-script-store";

const span = (index: number, start: number, end: number): SentenceSpan => ({
	index,
	start,
	end,
});

afterEach(() => {
	useTtsScriptStore.getState().clear();
});

describe("useTtsScriptStore", () => {
	test("publishing a script resets the previous read's spans", () => {
		const store = useTtsScriptStore.getState();
		store.setScript("a", ["one"]);
		store.setSpans([span(0, 0, 1)]);
		store.setScript("b", ["two"]);
		expect(useTtsScriptStore.getState().sentences).toEqual(["two"]);
		expect(useTtsScriptStore.getState().spans).toEqual([]);
	});

	test("re-publishing identical spans does not churn the store", () => {
		// The island's script body re-renders a whole paragraph; an unchanged span
		// list must not wake it.
		const store = useTtsScriptStore.getState();
		store.setScript("a", ["one"]);
		store.setSpans([span(0, 0, 1)]);
		const first = useTtsScriptStore.getState().spans;
		store.setSpans([span(0, 0, 1)]);
		expect(useTtsScriptStore.getState().spans).toBe(first);
	});

	test("a growing span list replaces the previous one", () => {
		const store = useTtsScriptStore.getState();
		store.setScript("a", ["one", "two"]);
		store.setSpans([span(0, 0, 1)]);
		store.setSpans([span(0, 0, 1), span(1, 1, 2)]);
		expect(useTtsScriptStore.getState().spans).toHaveLength(2);
	});

	test("a sentence that grew another chunk replaces the previous span list", () => {
		// Same span COUNT, longer audio — the length check alone would miss it.
		const store = useTtsScriptStore.getState();
		store.setScript("a", ["one"]);
		store.setSpans([span(0, 0, 1)]);
		store.setSpans([span(0, 0, 2)]);
		expect(useTtsScriptStore.getState().spans).toEqual([span(0, 0, 2)]);
	});

	test("clearFor drops the script when the read that ended owns it", () => {
		const store = useTtsScriptStore.getState();
		store.setScript("a", ["one"]);
		store.clearFor("a");
		expect(useTtsScriptStore.getState().sentences).toEqual([]);
		expect(useTtsScriptStore.getState().requestId).toBeNull();
	});

	test("clearFor keeps a newer read's script when an older read drains", () => {
		// Synthesis is serialized, playback is not: read A's audio can finish AFTER
		// read B has already published its script.
		const store = useTtsScriptStore.getState();
		store.setScript("b", ["newer"]);
		store.clearFor("a");
		expect(useTtsScriptStore.getState().sentences).toEqual(["newer"]);
		expect(useTtsScriptStore.getState().requestId).toBe("b");
	});

	test("an empty id is the wildcard the cancel-all path emits", () => {
		const store = useTtsScriptStore.getState();
		store.setScript("b", ["newer"]);
		store.clearFor("");
		expect(useTtsScriptStore.getState().sentences).toEqual([]);
	});
});

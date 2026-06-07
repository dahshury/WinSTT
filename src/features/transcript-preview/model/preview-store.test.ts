import { beforeEach, describe, expect, test } from "bun:test";
import { useTranscriptPreviewStore } from "./preview-store";

const store = () => useTranscriptPreviewStore.getState();

beforeEach(() => {
	store().reset();
});

describe("preview store · open", () => {
	test("stays in edit when the transcript was not auto-enhanced", () => {
		store().open({ original: "hello world", text: "hello world" });
		const s = store();
		expect(s.view).toBe("edit");
		expect(s.candidate).toBeNull();
		expect(s.diffBase).toBeNull();
		expect(s.isActive).toBe(true);
	});

	test("opens straight into the enhance diff when auto-enhanced", () => {
		store().open({ original: "helo wrld", text: "Hello, world." });
		const s = store();
		expect(s.view).toBe("enhance");
		expect(s.candidate).toBe("Hello, world.");
		expect(s.diffBase).toBe("helo wrld");
		expect(s.text).toBe("Hello, world.");
	});

	test("seeds the enhance config from the supplied dictation defaults", () => {
		store().open({
			original: "a",
			text: "a",
			presetKeys: ["formal"],
			modifierIds: ["m1"],
		});
		const s = store();
		expect(s.selectedPresetKeys).toEqual(["formal"]);
		expect(s.selectedModifierIds).toEqual(["m1"]);
	});
});

describe("preview store · diff review", () => {
	test("applyEnhancement with nothing rejected commits the exact candidate", () => {
		store().open({ original: "the quick fox", text: "the quick fox" });
		store().beginProcessing("the quick fox", null);
		store().finishProcessing("the swift fox.");
		store().applyEnhancement();
		const s = store();
		expect(s.text).toBe("the swift fox.");
		expect(s.candidate).toBeNull();
		expect(s.diffBase).toBeNull();
		expect(s.view).toBe("enhance");
	});

	test("rejecting a change reverts that span on apply", () => {
		store().open({ original: "the quick fox", text: "the quick fox" });
		store().beginProcessing("the quick fox", null);
		store().finishProcessing("the swift fox");
		store().toggleChangeDecision(0); // reject quick→swift
		store().applyEnhancement();
		expect(store().text).toBe("the quick fox");
	});

	test("toggleChangeDecision is idempotent back to accepted", () => {
		store().beginProcessing("the quick fox", null);
		store().finishProcessing("the swift fox");
		store().toggleChangeDecision(0);
		expect(store().rejectedChanges).toEqual([0]);
		store().toggleChangeDecision(0);
		expect(store().rejectedChanges).toEqual([]);
	});

	test("discardEnhancement drops the candidate without touching the text", () => {
		store().open({ original: "raw text", text: "raw text" });
		store().beginProcessing("raw text", null);
		store().finishProcessing("polished text");
		store().discardEnhancement();
		const s = store();
		expect(s.candidate).toBeNull();
		expect(s.text).toBe("raw text");
	});

	test("selection-scoped apply splices the result back into the full text", () => {
		store().open({ original: "hello world", text: "hello world" });
		// Select "world" (indices 6..11) and run on just that span.
		store().setSelection(6, 11);
		store().beginProcessing("world", { start: 6, end: 11 });
		store().finishProcessing("planet");
		store().applyEnhancement();
		expect(store().text).toBe("hello planet");
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FileQueueItem } from "@/shared/api/ipc-client";
import { useFileTranscriptionStore } from "./file-transcription-store";

function makeItem(over: Partial<FileQueueItem> = {}): FileQueueItem {
	return {
		id: "1",
		fileName: "a.wav",
		status: "queued",
		progress: 0,
		stage: "queued",
		message: "",
		...over,
	};
}

beforeEach(() => {
	useFileTranscriptionStore.getState().reset();
});

afterEach(() => {
	useFileTranscriptionStore.getState().reset();
});

describe("useFileTranscriptionStore", () => {
	test("initial state is an empty queue and not active", () => {
		const state = useFileTranscriptionStore.getState();
		expect(state.items).toEqual([]);
		expect(state.queueActive).toBe(false);
	});

	test("setItems replaces the whole queue", () => {
		useFileTranscriptionStore
			.getState()
			.setItems([makeItem({ id: "a" }), makeItem({ id: "b" })]);
		expect(useFileTranscriptionStore.getState().items.map((i) => i.id)).toEqual(
			["a", "b"],
		);
	});

	test("patchProgress updates only the matching row's progress + stage", () => {
		useFileTranscriptionStore.getState().setItems([
			makeItem({
				id: "a",
				status: "transcribing",
				progress: 0.1,
				stage: "transcribing",
			}),
			makeItem({ id: "b", progress: 0 }),
		]);
		useFileTranscriptionStore
			.getState()
			.patchProgress("a", 0.6, "transcribing");
		const items = useFileTranscriptionStore.getState().items;
		expect(items.find((i) => i.id === "a")?.progress).toBe(0.6);
		expect(items.find((i) => i.id === "b")?.progress).toBe(0);
	});

	test("patchProgress is a no-op for an unknown id", () => {
		useFileTranscriptionStore
			.getState()
			.setItems([makeItem({ id: "a", progress: 0.2 })]);
		useFileTranscriptionStore
			.getState()
			.patchProgress("missing", 0.9, "transcribing");
		expect(useFileTranscriptionStore.getState().items[0]?.progress).toBe(0.2);
	});

	test("setQueueActive toggles the cross-window busy flag", () => {
		useFileTranscriptionStore.getState().setQueueActive(true);
		expect(useFileTranscriptionStore.getState().queueActive).toBe(true);
		useFileTranscriptionStore.getState().setQueueActive(false);
		expect(useFileTranscriptionStore.getState().queueActive).toBe(false);
	});

	test("reset clears items and the active flag", () => {
		useFileTranscriptionStore.getState().setItems([makeItem()]);
		useFileTranscriptionStore.getState().setQueueActive(true);
		useFileTranscriptionStore.getState().reset();
		const state = useFileTranscriptionStore.getState();
		expect(state.items).toEqual([]);
		expect(state.queueActive).toBe(false);
	});
});

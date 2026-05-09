import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useFileTranscriptionStore } from "./file-transcription-store";

beforeEach(() => {
	useFileTranscriptionStore.getState().reset();
});

afterEach(() => {
	useFileTranscriptionStore.getState().reset();
});

describe("useFileTranscriptionStore", () => {
	test("initial state is idle with zeroed progress", () => {
		const state = useFileTranscriptionStore.getState();
		expect(state.status).toBe("idle");
		expect(state.progress).toBe(0);
		expect(state.message).toBe("");
		expect(state.fileName).toBe("");
	});

	test("setProcessing sets status='processing' and resets progress", () => {
		useFileTranscriptionStore.getState().setProgress(0.5, "old");
		useFileTranscriptionStore.getState().setProcessing("a.wav");
		const state = useFileTranscriptionStore.getState();
		expect(state.status).toBe("processing");
		expect(state.progress).toBe(0);
		expect(state.message).toBe("Starting...");
		expect(state.fileName).toBe("a.wav");
	});

	test("setProgress updates progress and message without changing status or fileName", () => {
		useFileTranscriptionStore.getState().setProcessing("a.wav");
		useFileTranscriptionStore.getState().setProgress(0.42, "halfway");
		const state = useFileTranscriptionStore.getState();
		expect(state.progress).toBe(0.42);
		expect(state.message).toBe("halfway");
		expect(state.status).toBe("processing");
		expect(state.fileName).toBe("a.wav");
	});

	test("setComplete moves to status='complete' with full progress", () => {
		useFileTranscriptionStore.getState().setComplete("a.wav");
		const state = useFileTranscriptionStore.getState();
		expect(state.status).toBe("complete");
		expect(state.progress).toBe(1);
		expect(state.fileName).toBe("a.wav");
	});

	test("setError moves to status='error' with the error message", () => {
		useFileTranscriptionStore.getState().setError("a.wav", "boom");
		const state = useFileTranscriptionStore.getState();
		expect(state.status).toBe("error");
		expect(state.message).toBe("boom");
		expect(state.fileName).toBe("a.wav");
	});

	test("reset returns to idle from any state", () => {
		useFileTranscriptionStore.getState().setError("a.wav", "boom");
		useFileTranscriptionStore.getState().reset();
		const state = useFileTranscriptionStore.getState();
		expect(state.status).toBe("idle");
		expect(state.progress).toBe(0);
		expect(state.message).toBe("");
		expect(state.fileName).toBe("");
	});

	test("setComplete schedules an idle reset after 3000ms (auto-clear)", async () => {
		useFileTranscriptionStore.getState().setComplete("a.wav");
		expect(useFileTranscriptionStore.getState().status).toBe("complete");
		await new Promise((resolve) => setTimeout(resolve, 3050));
		expect(useFileTranscriptionStore.getState().status).toBe("idle");
	}, 6000);

	test("a follow-up setProcessing within the auto-clear window cancels the reset", async () => {
		useFileTranscriptionStore.getState().setComplete("a.wav");
		// Within 3s, start a new processing — the deferred reset only fires if
		// status is still 'complete' at that point.
		await new Promise((resolve) => setTimeout(resolve, 100));
		useFileTranscriptionStore.getState().setProcessing("b.wav");
		await new Promise((resolve) => setTimeout(resolve, 3000));
		const state = useFileTranscriptionStore.getState();
		expect(state.status).toBe("processing");
		expect(state.fileName).toBe("b.wav");
	}, 6000);
});

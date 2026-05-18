import { afterEach, describe, expect, test } from "bun:test";
import type { LlmWarmupStatus } from "@/shared/api/ipc-client";
import { useWarmupStatusStore } from "./warmup-status-store";

afterEach(() => {
	useWarmupStatusStore.getState().clear();
});

const SAMPLE: LlmWarmupStatus = {
	endpoint: "http://localhost:11434",
	inProgress: false,
	reachable: true,
	ollamaInstalled: true,
	models: [{ model: "gemma3:4b", outcome: "ok" }],
	timestamp: 1_700_000_000,
};

describe("useWarmupStatusStore", () => {
	test("starts with status === null so banners stay hidden before first broadcast", () => {
		expect(useWarmupStatusStore.getState().status).toBeNull();
	});

	test("setStatus stores the payload verbatim", () => {
		useWarmupStatusStore.getState().setStatus(SAMPLE);
		expect(useWarmupStatusStore.getState().status).toEqual(SAMPLE);
	});

	test("clear resets to null so the banner disappears when the feature is disabled", () => {
		useWarmupStatusStore.getState().setStatus(SAMPLE);
		useWarmupStatusStore.getState().clear();
		expect(useWarmupStatusStore.getState().status).toBeNull();
	});
});

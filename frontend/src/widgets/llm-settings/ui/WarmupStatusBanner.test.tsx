import { describe, expect, test } from "bun:test";
import type { LlmWarmupStatus } from "@/shared/api/ipc-client";
import { __warmup_banner_test_helpers__ } from "./WarmupStatusBanner";

const { findModelStatus } = __warmup_banner_test_helpers__;

const SAMPLE: LlmWarmupStatus = {
	endpoint: "http://localhost:11434",
	inProgress: false,
	reachable: true,
	ollamaInstalled: true,
	models: [
		{ model: "gemma3:4b", outcome: "ok" },
		{ model: "llama3:8b", outcome: "model-not-found", errorBody: "not found" },
	],
	timestamp: 1,
};

describe("findModelStatus", () => {
	test("returns null when status is null (no broadcast yet)", () => {
		expect(findModelStatus(null, "gemma3:4b")).toBeNull();
	});

	test("returns null when model name is empty (settings not yet populated)", () => {
		expect(findModelStatus(SAMPLE, "")).toBeNull();
	});

	test("returns null when the model has no warmup record (model just changed, no warmup yet)", () => {
		expect(findModelStatus(SAMPLE, "mistral:7b")).toBeNull();
	});

	test("returns the matching record so the banner can pick its outcome", () => {
		expect(findModelStatus(SAMPLE, "llama3:8b")).toEqual({
			model: "llama3:8b",
			outcome: "model-not-found",
			errorBody: "not found",
		});
	});
});

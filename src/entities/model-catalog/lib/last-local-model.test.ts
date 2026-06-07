import { afterEach, describe, expect, test } from "bun:test";
import type { ModelInfo } from "../model/catalog-store";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import {
	readLastLocalSttModelHistory,
	readLastLocalSttModel,
	recordLastLocalSttModel,
	resolveLocalDefault,
} from "./last-local-model";

const m = (id: string): ModelInfo => ({ id }) as unknown as ModelInfo;
const models = [m("tiny"), m("base"), m("large")];
const state = (cached: boolean): ModelStateEntry =>
	({
		cache: { state: cached ? "cached" : "not_cached" },
		estimated_bytes: 1,
	}) as unknown as ModelStateEntry;
const states = {
	tiny: state(true),
	base: state(true),
	large: state(false),
};

afterEach(() => {
	localStorage.removeItem("winstt:last-local-stt-model");
	localStorage.removeItem("winstt:last-local-stt-model-history");
});

describe("recordLastLocalSttModel / readLastLocalSttModel", () => {
	test("round-trips a model id", () => {
		recordLastLocalSttModel("base");
		expect(readLastLocalSttModel()).toBe("base");
	});

	test("ignores an empty id", () => {
		recordLastLocalSttModel("base");
		recordLastLocalSttModel("");
		expect(readLastLocalSttModel()).toBe("base");
	});

	test("reads null when nothing was stored", () => {
		expect(readLastLocalSttModel()).toBeNull();
	});

	test("keeps most-recent-first history without duplicates", () => {
		recordLastLocalSttModel("tiny");
		recordLastLocalSttModel("base");
		recordLastLocalSttModel("tiny");
		expect(readLastLocalSttModelHistory()).toEqual(["tiny", "base"]);
	});
});

describe("resolveLocalDefault", () => {
	test("restores the remembered model when it is still cached", () => {
		recordLastLocalSttModel("base");
		expect(resolveLocalDefault(models, states)).toBe("base");
	});

	test("falls back to a cached catalog model when the remembered model is gone", () => {
		recordLastLocalSttModel("ghost-removed-model");
		expect(resolveLocalDefault(models, states)).toBe("tiny");
	});

	test("falls back to a cached catalog model when the remembered model is no longer cached", () => {
		recordLastLocalSttModel("large");
		expect(resolveLocalDefault(models, states)).toBe("tiny");
	});

	test("falls back to a cached catalog model when nothing is remembered", () => {
		expect(resolveLocalDefault(models, states)).toBe("tiny");
	});

	test("returns null when no local model is cached", () => {
		expect(
			resolveLocalDefault(models, {
				tiny: state(false),
				base: state(false),
				large: state(false),
			}),
		).toBeNull();
	});

	test("returns null for an empty catalog", () => {
		recordLastLocalSttModel("base");
		expect(resolveLocalDefault([], states)).toBeNull();
	});
});

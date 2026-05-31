import { afterEach, describe, expect, test } from "bun:test";
import type { ModelInfo } from "../model/catalog-store";
import {
	readLastLocalSttModel,
	recordLastLocalSttModel,
	resolveLocalDefault,
} from "./last-local-model";

const m = (id: string): ModelInfo => ({ id }) as unknown as ModelInfo;
const models = [m("tiny"), m("base"), m("large")];

afterEach(() => {
	localStorage.removeItem("winstt:last-local-stt-model");
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
});

describe("resolveLocalDefault", () => {
	test("restores the remembered model when it is still in the catalog", () => {
		recordLastLocalSttModel("base");
		expect(resolveLocalDefault(models, {})).toBe("base");
	});

	test("falls back to the catalog default when the remembered model is gone", () => {
		recordLastLocalSttModel("ghost-removed-model");
		// Nothing cached → smallest/first catalog entry wins.
		expect(resolveLocalDefault(models, {})).toBe("tiny");
	});

	test("falls back to the catalog default when nothing is remembered", () => {
		expect(resolveLocalDefault(models, {})).toBe("tiny");
	});

	test("returns null for an empty catalog", () => {
		recordLastLocalSttModel("base");
		expect(resolveLocalDefault([], {})).toBeNull();
	});
});

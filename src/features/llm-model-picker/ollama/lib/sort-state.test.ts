import { describe, expect, it } from "bun:test";
import type { OllamaModel } from "@/shared/api/models";
import { sortOllamaModels } from "./sort-state";

function model(
	overrides: Partial<OllamaModel> & { name: string },
): OllamaModel {
	return { size: 0, modifiedAt: "", ...overrides };
}

const names = (models: readonly OllamaModel[]): string[] =>
	models.map((m) => m.name);

describe("sortOllamaModels", () => {
	it("sorts by name A→Z, case-insensitively", () => {
		const models = [
			model({ name: "qwen3" }),
			model({ name: "Gemma3" }),
			model({ name: "llama3" }),
		];
		expect(names(sortOllamaModels(models, "name"))).toEqual([
			"Gemma3",
			"llama3",
			"qwen3",
		]);
	});

	it("sorts by on-disk size, smallest first", () => {
		const models = [
			model({ name: "big", size: 900 }),
			model({ name: "small", size: 100 }),
			model({ name: "mid", size: 400 }),
		];
		expect(names(sortOllamaModels(models, "size"))).toEqual([
			"small",
			"mid",
			"big",
		]);
	});

	it("sorts models with unknown/zero size to the end (size key)", () => {
		const models = [
			{ name: "unknown", modifiedAt: "" },
			model({ name: "zero", size: 0 }),
			model({ name: "known", size: 300 }),
		];
		const sorted = names(sortOllamaModels(models, "size"));
		expect(sorted[0]).toBe("known");
		expect(sorted.slice(1).sort()).toEqual(["unknown", "zero"]);
	});

	it("sorts by parameter count ascending (B/M/K parsed)", () => {
		const models = [
			model({ name: "seven", details: { parameterSize: "7B" } }),
			model({ name: "tiny", details: { parameterSize: "270m" } }),
			model({ name: "small", details: { parameterSize: "1.2B" } }),
		];
		expect(names(sortOllamaModels(models, "params"))).toEqual([
			"tiny",
			"small",
			"seven",
		]);
	});

	it("sorts models with unknown params to the end (params key)", () => {
		const models = [
			model({ name: "missing" }),
			model({ name: "bogus", details: { parameterSize: "huge" } }),
			model({ name: "known", details: { parameterSize: "3B" } }),
		];
		const sorted = names(sortOllamaModels(models, "params"));
		expect(sorted[0]).toBe("known");
		expect(sorted.slice(1).sort()).toEqual(["bogus", "missing"]);
	});

	it("breaks size ties on an A→Z name compare", () => {
		const models = [
			model({ name: "zeta", size: 500 }),
			model({ name: "alpha", size: 500 }),
		];
		expect(names(sortOllamaModels(models, "size"))).toEqual(["alpha", "zeta"]);
	});

	it("breaks param ties on an A→Z name compare", () => {
		const models = [
			model({ name: "zeta", details: { parameterSize: "7B" } }),
			model({ name: "alpha", details: { parameterSize: "7B" } }),
		];
		expect(names(sortOllamaModels(models, "params"))).toEqual([
			"alpha",
			"zeta",
		]);
	});

	it("orders two unknown-size models by name without NaN scrambling", () => {
		const models = [
			model({ name: "zeta", size: 0 }),
			{ name: "alpha", modifiedAt: "" },
		];
		expect(names(sortOllamaModels(models, "size"))).toEqual(["alpha", "zeta"]);
	});

	it("never mutates the input array", () => {
		const models = [
			model({ name: "b", size: 100 }),
			model({ name: "a", size: 900 }),
		];
		const before = names(models);
		sortOllamaModels(models, "size");
		expect(names(models)).toEqual(before);
	});
});

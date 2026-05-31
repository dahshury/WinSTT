import { describe, expect, it } from "bun:test";
import type { OpenRouterModel } from "@/shared/api/models";
import { sortOpenRouterModels } from "./openrouter-sort";

function model(
	overrides: Partial<OpenRouterModel> & { id: string; name: string }
): OpenRouterModel {
	return overrides as OpenRouterModel;
}

const ids = (models: readonly OpenRouterModel[]): string[] => models.map((m) => m.id);

describe("sortOpenRouterModels", () => {
	it("sorts by name A→Z, case-insensitively", () => {
		const models = [
			model({ id: "c", name: "cohere" }),
			model({ id: "a", name: "Apple" }),
			model({ id: "b", name: "balsa" }),
		];
		expect(ids(sortOpenRouterModels(models, "name"))).toEqual(["a", "b", "c"]);
	});

	it("sorts by context length, largest window first", () => {
		const models = [
			model({ id: "small", name: "Small", context_length: 8000 }),
			model({ id: "huge", name: "Huge", context_length: 1_000_000 }),
			model({ id: "mid", name: "Mid", context_length: 128_000 }),
		];
		expect(ids(sortOpenRouterModels(models, "context"))).toEqual(["huge", "mid", "small"]);
	});

	it("sorts models with missing/zero context to the end (context key)", () => {
		const models = [
			model({ id: "missing", name: "Missing" }),
			model({ id: "zero", name: "Zero", context_length: 0 }),
			model({ id: "known", name: "Known", context_length: 32_000 }),
		];
		const sorted = ids(sortOpenRouterModels(models, "context"));
		expect(sorted[0]).toBe("known");
		expect(sorted.slice(1).sort()).toEqual(["missing", "zero"]);
	});

	it("sorts by prompt price, cheapest (and free) first", () => {
		const models = [
			model({ id: "pricey", name: "Pricey", pricing: { prompt: "0.00001" } }),
			model({ id: "free", name: "Free", pricing: { prompt: "0" } }),
			model({ id: "cheap", name: "Cheap", pricing: { prompt: "0.000001" } }),
		];
		expect(ids(sortOpenRouterModels(models, "price"))).toEqual(["free", "cheap", "pricey"]);
	});

	it("sorts models with missing/unparseable price to the end (price key)", () => {
		const models = [
			model({ id: "missing", name: "Missing" }),
			model({ id: "nan", name: "Nan", pricing: { prompt: "n/a" } }),
			model({ id: "known", name: "Known", pricing: { prompt: "0.000002" } }),
		];
		const sorted = ids(sortOpenRouterModels(models, "price"));
		expect(sorted[0]).toBe("known");
		expect(sorted.slice(1).sort()).toEqual(["missing", "nan"]);
	});

	it("breaks context ties with an A→Z name compare", () => {
		const models = [
			model({ id: "z", name: "Zeta", context_length: 128_000 }),
			model({ id: "a", name: "Alpha", context_length: 128_000 }),
		];
		expect(ids(sortOpenRouterModels(models, "context"))).toEqual(["a", "z"]);
	});

	it("breaks price ties with an A→Z name compare", () => {
		const models = [
			model({ id: "z", name: "Zeta", pricing: { prompt: "0" } }),
			model({ id: "a", name: "Alpha", pricing: { prompt: "0" } }),
		];
		expect(ids(sortOpenRouterModels(models, "price"))).toEqual(["a", "z"]);
	});

	it("orders missing-price models among themselves by name", () => {
		const models = [model({ id: "z", name: "Zeta" }), model({ id: "a", name: "Alpha" })];
		expect(ids(sortOpenRouterModels(models, "price"))).toEqual(["a", "z"]);
	});

	it("never mutates the input array", () => {
		const models = [
			model({ id: "b", name: "Beta", context_length: 1000 }),
			model({ id: "a", name: "Alpha", context_length: 9000 }),
		];
		const before = ids(models);
		sortOpenRouterModels(models, "context");
		expect(ids(models)).toEqual(before);
	});
});

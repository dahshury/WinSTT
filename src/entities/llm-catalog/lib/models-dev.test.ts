import { describe, expect, test } from "bun:test";
import {
	lookupModelsDev,
	normalizeModelKey,
	parseModelsDevApi,
} from "./models-dev";

const SAMPLE = {
	moonshotai: {
		id: "moonshotai",
		name: "Moonshot AI",
		models: {
			"kimi-k2": {
				id: "kimi-k2",
				name: "Kimi K2",
				knowledge: "2024-12",
				release_date: "2025-09-05",
				last_updated: "2025-09-05",
				reasoning: true,
				tool_call: true,
				modalities: { input: ["text", "image"], output: ["text"] },
				open_weights: true,
				limit: { context: 256_000, output: 64_000 },
			},
		},
	},
	openai: {
		id: "openai",
		name: "OpenAI",
		models: {
			"gpt-4o": {
				id: "gpt-4o",
				name: "GPT-4o",
				knowledge: "2023-10",
				tool_call: true,
			},
		},
	},
};

describe("normalizeModelKey", () => {
	test("drops vendor prefix, snapshot suffix and punctuation", () => {
		expect(normalizeModelKey("moonshotai/kimi-k2-0905")).toBe("kimik2");
		expect(normalizeModelKey("kimi-k2:free")).toBe("kimik2");
		expect(normalizeModelKey("Kimi K2")).toBe("kimik2");
		expect(normalizeModelKey("openai/gpt-4o")).toBe("gpt4o");
	});

	test("strips dated snapshots in several shapes", () => {
		expect(normalizeModelKey("claude-3-5-sonnet-2024-11")).toBe(
			normalizeModelKey("claude-3-5-sonnet"),
		);
		expect(normalizeModelKey("model-latest")).toBe("model");
	});
});

describe("parseModelsDevApi", () => {
	test("flattens providers and trims fields", () => {
		const index = parseModelsDevApi(SAMPLE);
		const entry = index[normalizeModelKey("kimi-k2")];
		expect(entry).toBeDefined();
		expect(entry?.developer).toBe("Moonshot AI");
		expect(entry?.knowledge).toBe("2024-12");
		expect(entry?.releaseDate).toBe("2025-09-05");
		expect(entry?.reasoning).toBe(true);
		expect(entry?.toolCall).toBe(true);
		expect(entry?.inputModalities).toEqual(["text", "image"]);
		expect(entry?.contextLimit).toBe(256_000);
		expect(entry?.openWeights).toBe(true);
	});

	test("indexes by id and by display name", () => {
		const index = parseModelsDevApi(SAMPLE);
		expect(index[normalizeModelKey("GPT-4o")]).toBeDefined();
		expect(index[normalizeModelKey("gpt-4o")]).toBeDefined();
	});

	test("returns empty index for non-object input", () => {
		expect(parseModelsDevApi(null)).toEqual({});
		expect(parseModelsDevApi("nope")).toEqual({});
		expect(parseModelsDevApi(42)).toEqual({});
	});
});

describe("lookupModelsDev", () => {
	const index = parseModelsDevApi(SAMPLE);

	test("resolves an OpenRouter-style id by suffix + snapshot strip", () => {
		const entry = lookupModelsDev(index, "moonshotai/kimi-k2-0905", "Kimi K2");
		expect(entry?.developer).toBe("Moonshot AI");
	});

	test("falls back to name match when id misses", () => {
		const entry = lookupModelsDev(index, "totally/unknown-id", "GPT-4o");
		expect(entry?.developer).toBe("OpenAI");
	});

	test("returns null when nothing matches", () => {
		expect(lookupModelsDev(index, "acme/does-not-exist")).toBeNull();
	});
});

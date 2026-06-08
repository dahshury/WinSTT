import { describe, expect, test } from "bun:test";
import {
	CLOUD_CATALOG,
	CLOUD_PROVIDERS,
	type CloudModel,
	defaultCloudModelId,
	getApiKeyUrl,
	mergeCloudModels,
	pickDefaultCloudModel,
	prettifyModelId,
	providerDisplayName,
	providerOf,
} from "./catalog";

describe("CLOUD_PROVIDERS", () => {
	test("contains elevenlabs and openrouter (openai removed)", () => {
		expect([...CLOUD_PROVIDERS].sort()).toEqual(["elevenlabs", "openrouter"]);
	});
});

describe("CLOUD_CATALOG", () => {
	test("each curated provider exposes at least one model", () => {
		// OpenRouter is excluded: its transcription rows are fetched live
		// (useOpenRouterSttCatalogStore), so its static catalog is intentionally empty.
		for (const provider of CLOUD_PROVIDERS.filter((p) => p !== "openrouter")) {
			expect(CLOUD_CATALOG[provider].length).toBeGreaterThan(0);
		}
	});

	test("openrouter has no static catalog (dynamic scan)", () => {
		expect(CLOUD_CATALOG.openrouter).toEqual([]);
	});

	test("elevenlabs catalog flags scribe_v1 as the default", () => {
		const elevenlabs = CLOUD_CATALOG.elevenlabs;
		expect(elevenlabs.find((m) => m.id === "scribe_v1")?.isDefault).toBe(true);
	});
});

describe("providerOf", () => {
	test("treats a legacy openai: prefix as unknown (provider removed)", () => {
		expect(providerOf("openai:whisper-1")).toBeNull();
	});

	test("recognizes the elevenlabs: prefix", () => {
		expect(providerOf("elevenlabs:scribe_v1")).toBe("elevenlabs");
	});

	test("recognizes the openrouter: prefix (incl. slashed maker ids)", () => {
		expect(providerOf("openrouter:microsoft/mai-transcribe-1.5")).toBe(
			"openrouter",
		);
		expect(providerOf("openrouter:")).toBe("openrouter");
	});

	test("returns null for unprefixed or unknown model ids", () => {
		expect(providerOf("whisper-1")).toBeNull();
		expect(providerOf("anthropic:claude")).toBeNull();
		expect(providerOf("")).toBeNull();
	});
});

describe("pickDefaultCloudModel", () => {
	test("returns the entry flagged isDefault when present", () => {
		const catalog: CloudModel[] = [
			{ id: "a", displayName: "A" },
			{ id: "b", displayName: "B", isDefault: true },
			{ id: "c", displayName: "C" },
		];
		expect(pickDefaultCloudModel(catalog)?.id).toBe("b");
	});

	test("falls back to the first entry when no model is flagged default", () => {
		const catalog: CloudModel[] = [
			{ id: "first", displayName: "First" },
			{ id: "second", displayName: "Second" },
		];
		expect(pickDefaultCloudModel(catalog)?.id).toBe("first");
	});

	test("returns null when the catalog is empty", () => {
		expect(pickDefaultCloudModel([])).toBeNull();
	});

	test("prefers the explicitly-flagged entry over the first one", () => {
		// Locks the precedence rule: a later-flagged default wins over the
		// fallback-to-index-0 path.
		const catalog: CloudModel[] = [
			{ id: "first", displayName: "First" },
			{ id: "later", displayName: "Later", isDefault: true },
		];
		expect(pickDefaultCloudModel(catalog)?.id).toBe("later");
	});
});

describe("defaultCloudModelId", () => {
	test("returns provider-prefixed default id for elevenlabs", () => {
		expect(defaultCloudModelId("elevenlabs")).toBe("elevenlabs:scribe_v1");
	});

	test("returns the bare 'openrouter:' prefix (dynamic; picker self-heals)", () => {
		expect(defaultCloudModelId("openrouter")).toBe("openrouter:");
	});
});

describe("getApiKeyUrl", () => {
	test("elevenlabs routes to the elevenlabs.io API keys page", () => {
		expect(getApiKeyUrl("elevenlabs")).toBe(
			"https://elevenlabs.io/app/settings/api-keys",
		);
	});

	test("openrouter routes to the openrouter.ai keys page", () => {
		expect(getApiKeyUrl("openrouter")).toBe("https://openrouter.ai/keys");
	});
});

describe("providerDisplayName", () => {
	test("returns 'ElevenLabs' for elevenlabs", () => {
		expect(providerDisplayName("elevenlabs")).toBe("ElevenLabs");
	});

	test("returns 'OpenRouter' for openrouter", () => {
		expect(providerDisplayName("openrouter")).toBe("OpenRouter");
	});
});

describe("prettifyModelId", () => {
	test("normalizes separators and uppercases the gpt token", () => {
		expect(prettifyModelId("gpt-4o-mini-transcribe-2025-12-15")).toBe(
			"GPT 4o Mini Transcribe 2025 12 15",
		);
		expect(prettifyModelId("scribe_v1_experimental")).toBe(
			"Scribe V1 Experimental",
		);
	});
});

describe("mergeCloudModels", () => {
	const curated: CloudModel[] = [
		{
			id: "gpt-4o-mini-transcribe",
			displayName: "GPT-4o mini transcribe",
			isDefault: true,
		},
		{ id: "whisper-1", displayName: "Whisper v1" },
	];

	test("keeps curated entries first with their metadata", () => {
		const merged = mergeCloudModels(curated, [{ id: "whisper-1" }]);
		expect(merged.slice(0, 2)).toEqual(curated);
	});

	test("appends unknown dynamic ids with provider or prettified labels", () => {
		const merged = mergeCloudModels(curated, [
			{
				id: "gpt-4o-transcribe-diarize",
				displayName: "GPT-4o transcribe (diarize)",
			},
			{ id: "gpt-4o-transcribe-2099-01-01" },
		]);
		expect(merged.map((m) => m.id)).toEqual([
			"gpt-4o-mini-transcribe",
			"whisper-1",
			"gpt-4o-transcribe-diarize",
			"gpt-4o-transcribe-2099-01-01",
		]);
		expect(merged[2]?.displayName).toBe("GPT-4o transcribe (diarize)");
		// No provider label → prettified id.
		expect(merged[3]?.displayName).toBe("GPT 4o Transcribe 2099 01 01");
	});

	test("dedupes by id (idempotent re-scan)", () => {
		const once = mergeCloudModels(curated, [{ id: "gpt-4o-transcribe" }]);
		const twice = mergeCloudModels(once, [{ id: "gpt-4o-transcribe" }]);
		expect(twice).toEqual(once);
	});

	test("retains curated entries the scan omits (union, never drops)", () => {
		const merged = mergeCloudModels(curated, []);
		expect(merged).toEqual(curated);
	});
});

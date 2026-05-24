import { describe, expect, test } from "bun:test";
import {
	CLOUD_CATALOG,
	CLOUD_PROVIDERS,
	type CloudModel,
	defaultCloudModelId,
	getApiKeyUrl,
	pickDefaultCloudModel,
	providerDisplayName,
	providerOf,
} from "./catalog";

describe("CLOUD_PROVIDERS", () => {
	test("contains exactly openai and elevenlabs", () => {
		expect([...CLOUD_PROVIDERS].sort()).toEqual(["elevenlabs", "openai"]);
	});
});

describe("CLOUD_CATALOG", () => {
	test("each provider exposes at least one model", () => {
		for (const provider of CLOUD_PROVIDERS) {
			expect(CLOUD_CATALOG[provider].length).toBeGreaterThan(0);
		}
	});

	test("openai catalog flags gpt-4o-mini-transcribe as the default", () => {
		const openai = CLOUD_CATALOG.openai;
		expect(openai.find((m) => m.id === "gpt-4o-mini-transcribe")?.isDefault).toBe(true);
	});

	test("elevenlabs catalog flags scribe_v1 as the default", () => {
		const elevenlabs = CLOUD_CATALOG.elevenlabs;
		expect(elevenlabs.find((m) => m.id === "scribe_v1")?.isDefault).toBe(true);
	});
});

describe("providerOf", () => {
	test("recognizes the openai: prefix", () => {
		expect(providerOf("openai:whisper-1")).toBe("openai");
	});

	test("recognizes the elevenlabs: prefix", () => {
		expect(providerOf("elevenlabs:scribe_v1")).toBe("elevenlabs");
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
	test("returns provider-prefixed default id for openai", () => {
		expect(defaultCloudModelId("openai")).toBe("openai:gpt-4o-mini-transcribe");
	});

	test("returns provider-prefixed default id for elevenlabs", () => {
		expect(defaultCloudModelId("elevenlabs")).toBe("elevenlabs:scribe_v1");
	});
});

describe("getApiKeyUrl", () => {
	test("openai routes to the platform.openai.com API keys page", () => {
		expect(getApiKeyUrl("openai")).toBe("https://platform.openai.com/api-keys");
	});

	test("elevenlabs routes to the elevenlabs.io API keys page", () => {
		expect(getApiKeyUrl("elevenlabs")).toBe("https://elevenlabs.io/app/settings/api-keys");
	});
});

describe("providerDisplayName", () => {
	test("returns 'OpenAI' for openai", () => {
		expect(providerDisplayName("openai")).toBe("OpenAI");
	});

	test("returns 'ElevenLabs' for elevenlabs", () => {
		expect(providerDisplayName("elevenlabs")).toBe("ElevenLabs");
	});
});

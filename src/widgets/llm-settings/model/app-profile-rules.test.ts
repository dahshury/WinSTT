import { describe, expect, test } from "bun:test";
import type { LlmConfiguration, SavedConfiguration } from "./configurations";
import {
	configSnapshotFromSavedConfiguration,
	normalizeExeInput,
	normalizeUrlPatternInput,
	ruleIsValid,
	syncRuleSnapshots,
	type AppProfileRule,
} from "./app-profile-rules";

function configuration(
	overrides: Partial<LlmConfiguration> = {},
): LlmConfiguration {
	return {
		enabled: true,
		provider: "ollama",
		model: "qwen3:4b",
		openrouterModel: "",
		openrouterFallbackModel: "",
		reasoningEffort: "medium",
		thinkingEffort: "off",
		verbosity: "medium",
		maxOutputTokens: null,
		presets: [{ key: "neutral" }],
		customModifiers: [],
		...overrides,
	};
}

function saved(
	id: string,
	name: string,
	config = configuration(),
): SavedConfiguration {
	return { id, name, config };
}

function rule(config = saved("formal", "Formal")): AppProfileRule {
	return {
		id: "rule-1",
		enabled: true,
		appExe: "chrome.exe",
		titlePattern: "",
		urlPattern: "gmail.com",
		configurationId: config.id,
		configurationName: config.name,
		config: configSnapshotFromSavedConfiguration(config.config),
	};
}

describe("per-app profile rule helpers", () => {
	test("normalizes executable paths and browser domains", () => {
		expect(normalizeExeInput(" C:\\Program Files\\Chrome\\CHROME.EXE ")).toBe(
			"chrome.exe",
		);
		expect(
			normalizeUrlPatternInput("https://www.Mail.Gmail.com:443/inbox"),
		).toBe("mail.gmail.com");
	});

	test("requires a configuration and at least one matcher", () => {
		expect(
			ruleIsValid({
				appExe: "",
				titlePattern: "",
				urlPattern: "",
				configurationId: "formal",
			}),
		).toBe(false);
		expect(
			ruleIsValid({
				appExe: "chrome.exe",
				titlePattern: "",
				urlPattern: "",
				configurationId: "formal",
			}),
		).toBe(true);
	});

	test("snapshots omit the authoritative enabled switch", () => {
		const snapshot = configSnapshotFromSavedConfiguration(configuration());
		expect("enabled" in snapshot).toBe(false);
		expect(snapshot.model).toBe("qwen3:4b");
	});

	test("refreshes renamed and edited configurations", () => {
		const original = saved("formal", "Formal");
		const updated = saved(
			"formal",
			"Formal email",
			configuration({ model: "qwen3:8b", presets: [{ key: "formal" }] }),
		);
		const result = syncRuleSnapshots([rule(original)], [updated]);
		expect(result.changed).toBe(true);
		expect(result.rules[0]?.configurationName).toBe("Formal email");
		expect(result.rules[0]?.config.model).toBe("qwen3:8b");
	});

	test("keeps deleted configurations on their last working snapshot", () => {
		const orphan = rule();
		const result = syncRuleSnapshots([orphan], []);
		expect(result.changed).toBe(false);
		expect(result.rules[0]).toBe(orphan);
	});
});

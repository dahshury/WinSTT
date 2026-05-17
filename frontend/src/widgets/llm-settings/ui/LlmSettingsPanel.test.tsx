import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import {
	__llm_settings_panel_test_helpers__ as helpers,
	LlmSettingsPanel,
} from "./LlmSettingsPanel";

describe("LlmSettingsPanel", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<LlmSettingsPanel />
			</IntlProvider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});

const tStub = ((key: string, vars?: Record<string, unknown>) =>
	vars ? `${key}:${JSON.stringify(vars)}` : key) as any;

describe("LlmSettingsPanel helpers — readLlmSnapshot", () => {
	test("returns DEFAULT_LLM when input is null", () => {
		expect(helpers.readLlmSnapshot(null)).toEqual(helpers.DEFAULT_LLM);
	});

	test("merges partial llm settings over the defaults", () => {
		// `readLlmSnapshot` accepts a forgiving partial input (the runtime body
		// re-defaults missing fields), but its TS signature reflects the strict
		// shape — cast for the test fixture to exercise the partial-merge logic.
		const snap = helpers.readLlmSnapshot({
			openrouterApiKey: "sk-test",
			dictation: { provider: "openrouter" } as any,
		});
		expect(snap.dictation.provider).toBe("openrouter");
		expect(snap.openrouterApiKey).toBe("sk-test");
		expect(snap.endpoint).toBe(helpers.DEFAULT_LLM.endpoint);
		// Transforms defaults remain untouched
		expect(snap.transforms.provider).toBe("ollama");
		expect(snap.transforms.enabled).toBe(false);
	});
});

describe("LlmSettingsPanel helpers — buildToneOpts / buildLevelOpts", () => {
	test("buildToneOpts returns the five tone entries with stable order", () => {
		const opts = helpers.buildToneOpts(tStub);
		expect(opts.map((o) => o.value)).toEqual([
			"neutral",
			"formal",
			"friendly",
			"technical",
			"casual",
		]);
	});

	test("each tone option has a label and icon", () => {
		const opts = helpers.buildToneOpts(tStub);
		for (const opt of opts) {
			expect(typeof opt.label).toBe("string");
			expect(opt.icon).toBeDefined();
		}
	});

	test("buildLevelOpts returns light/medium/high", () => {
		const opts = helpers.buildLevelOpts(tStub);
		expect(opts.map((o) => o.value)).toEqual(["light", "medium", "high"]);
	});
});

describe("LlmSettingsPanel helpers — presets array mutators", () => {
	test("getToneKey returns 'neutral' for empty list", () => {
		expect(helpers.getToneKey([])).toBe("neutral");
	});

	test("setTone replaces the existing tone", () => {
		const out = helpers.setTone([{ key: "formal" }, { key: "summarize" }], "casual");
		expect(out.find((p) => p.key === "casual")).toBeDefined();
		expect(out.find((p) => p.key === "formal")).toBeUndefined();
		expect(out.find((p) => p.key === "summarize")).toBeDefined();
	});

	test("toggleIndependent adds with default level for leveled presets", () => {
		const out = helpers.toggleIndependent([{ key: "neutral" }], "summarize", true);
		expect(out).toContainEqual({ key: "summarize", level: "medium" });
	});

	test("toggleIndependent adds without level for non-leveled presets", () => {
		const out = helpers.toggleIndependent([{ key: "neutral" }], "reorder", true);
		expect(out).toContainEqual({ key: "reorder" });
	});

	test("toggleIndependent removes when set false", () => {
		const out = helpers.toggleIndependent(
			[{ key: "neutral" }, { key: "summarize", level: "high" }],
			"summarize",
			false
		);
		expect(out.some((p) => p.key === "summarize")).toBe(false);
	});

	test("setIndependentLevel updates only the matching key", () => {
		const out = helpers.setIndependentLevel(
			[
				{ key: "summarize", level: "light" },
				{ key: "concise", level: "high" },
			],
			"summarize",
			"high"
		);
		expect(out).toEqual([
			{ key: "summarize", level: "high" },
			{ key: "concise", level: "high" },
		]);
	});
});

describe("LlmSettingsPanel helpers — buildProviderOpts", () => {
	test("returns ollama and openrouter providers", () => {
		const opts = helpers.buildProviderOpts(tStub);
		expect(opts.map((o) => o.value)).toEqual(["ollama", "openrouter"]);
	});

	test("provider labels are non-empty", () => {
		const opts = helpers.buildProviderOpts(tStub);
		for (const opt of opts) {
			expect(opt.label.length).toBeGreaterThan(0);
		}
	});
});

describe("LlmSettingsPanel helpers — pickReplacementOllamaModel", () => {
	test("returns null when current model is still installed", () => {
		expect(helpers.pickReplacementOllamaModel([{ name: "a" }, { name: "b" }], "a")).toBeNull();
	});

	test("returns first model when current is missing", () => {
		expect(helpers.pickReplacementOllamaModel([{ name: "x" }], "missing")).toBe("x");
	});

	test("returns null when models list is empty", () => {
		expect(helpers.pickReplacementOllamaModel([], "anything")).toBeNull();
	});
});

describe("LlmSettingsPanel helpers — shouldSyncOllamaModel", () => {
	test("returns null when provider is not ollama", () => {
		expect(helpers.shouldSyncOllamaModel("openrouter", [{ name: "a" }], "z")).toBeNull();
	});

	test("returns replacement when provider is ollama and current model missing", () => {
		expect(helpers.shouldSyncOllamaModel("ollama", [{ name: "a" }], "z")).toBe("a");
	});
});

describe("LlmSettingsPanel helpers — shouldScanOpenRouter", () => {
	const cases: [string, string, boolean, boolean][] = [
		["openrouter", "key", false, true],
		["openrouter", "", false, false],
		["openrouter", "key", true, false],
		["ollama", "key", false, false],
	];
	test.each(cases)("provider=%s key=%s loaded=%s -> %s", (provider, key, loaded, expected) => {
		expect(helpers.shouldScanOpenRouter(provider, key, loaded)).toBe(expected);
	});
});

interface ToggleDepsForTest {
	checkOllamaReachable: ReturnType<typeof mock>;
	ollamaLoaded: boolean;
	openrouterApiKey: string;
	openrouterLoaded: boolean;
	provider: string;
	scanOllama: ReturnType<typeof mock>;
	scanOpenRouter: ReturnType<typeof mock>;
	setEnabled: ReturnType<typeof mock>;
	setShowApiKeyDialog: ReturnType<typeof mock>;
	setShowOllamaDialog: ReturnType<typeof mock>;
}

function makeDeps(overrides: Partial<ToggleDepsForTest> = {}): ToggleDepsForTest {
	return {
		provider: "ollama",
		openrouterApiKey: "",
		ollamaLoaded: false,
		openrouterLoaded: false,
		checkOllamaReachable: mock(() => Promise.resolve(true)),
		scanOllama: mock(() => undefined),
		scanOpenRouter: mock(() => undefined),
		setEnabled: mock(() => undefined),
		setShowOllamaDialog: mock(() => undefined),
		setShowApiKeyDialog: mock(() => undefined),
		...overrides,
	};
}

describe("LlmSettingsPanel helpers — tryEnableOllamaForFeature", () => {
	test("opens dialog when Ollama is unreachable", async () => {
		const deps = makeDeps({
			checkOllamaReachable: mock(() => Promise.resolve(false)),
		});
		await helpers.tryEnableOllamaForFeature(deps as any);
		expect(deps.setShowOllamaDialog).toHaveBeenCalledWith(true);
		expect(deps.setEnabled).not.toHaveBeenCalled();
	});

	test("scans and enables when reachable and not yet loaded", async () => {
		const deps = makeDeps();
		await helpers.tryEnableOllamaForFeature(deps as any);
		expect(deps.scanOllama).toHaveBeenCalledTimes(1);
		expect(deps.setEnabled).toHaveBeenCalledWith(true);
	});

	test("skips scan when already loaded", async () => {
		const deps = makeDeps({ ollamaLoaded: true });
		await helpers.tryEnableOllamaForFeature(deps as any);
		expect(deps.scanOllama).not.toHaveBeenCalled();
		expect(deps.setEnabled).toHaveBeenCalledWith(true);
	});
});

describe("LlmSettingsPanel helpers — tryEnableOpenRouterForFeature", () => {
	test("opens api key dialog when key missing", () => {
		const deps = makeDeps({ provider: "openrouter" });
		helpers.tryEnableOpenRouterForFeature(deps as any);
		expect(deps.setShowApiKeyDialog).toHaveBeenCalledWith(true);
		expect(deps.setEnabled).not.toHaveBeenCalled();
	});

	test("enables and scans when key present and not loaded", () => {
		const deps = makeDeps({ provider: "openrouter", openrouterApiKey: "k" });
		helpers.tryEnableOpenRouterForFeature(deps as any);
		expect(deps.scanOpenRouter).toHaveBeenCalled();
		expect(deps.setEnabled).toHaveBeenCalledWith(true);
	});

	test("skips scan when already loaded", () => {
		const deps = makeDeps({
			provider: "openrouter",
			openrouterApiKey: "k",
			openrouterLoaded: true,
		});
		helpers.tryEnableOpenRouterForFeature(deps as any);
		expect(deps.scanOpenRouter).not.toHaveBeenCalled();
		expect(deps.setEnabled).toHaveBeenCalledWith(true);
	});
});

describe("LlmSettingsPanel helpers — performFeatureToggle", () => {
	test("disables without provider checks when next is false", async () => {
		const deps = makeDeps();
		await helpers.performFeatureToggle(false, deps as any);
		expect(deps.setEnabled).toHaveBeenCalledWith(false);
		expect(deps.checkOllamaReachable).not.toHaveBeenCalled();
	});

	test("delegates to ollama enable path when provider=ollama", async () => {
		const deps = makeDeps({ provider: "ollama" });
		await helpers.performFeatureToggle(true, deps as any);
		expect(deps.checkOllamaReachable).toHaveBeenCalled();
	});

	test("delegates to openrouter enable path when provider=openrouter", async () => {
		const deps = makeDeps({ provider: "openrouter" });
		await helpers.performFeatureToggle(true, deps as any);
		expect(deps.setShowApiKeyDialog).toHaveBeenCalledWith(true);
	});
});

describe("LlmSettingsPanel helpers — getOllamaDialogTexts", () => {
	test("uses notRunning copy when showRun is true", () => {
		const texts = helpers.getOllamaDialogTexts(true, tStub);
		expect(texts.title).toBe("ollamaNotRunning");
		expect(texts.description).toBe("ollamaNotRunningDescription");
	});

	test("uses required copy when showRun is false", () => {
		const texts = helpers.getOllamaDialogTexts(false, tStub);
		expect(texts.title).toBe("ollamaRequired");
		expect(texts.description).toBe("ollamaRequiredDescription");
	});
});

describe("LlmSettingsPanel helpers — DEFAULT_LLM / DEFAULT_FEATURE", () => {
	test("DEFAULT_LLM contains expected baseline values", () => {
		expect(helpers.DEFAULT_LLM.endpoint).toBe("http://localhost:11434");
		expect(helpers.DEFAULT_LLM.openrouterApiKey).toBe("");
		expect(helpers.DEFAULT_LLM.dictation.enabled).toBe(false);
		expect(helpers.DEFAULT_LLM.dictation.provider).toBe("ollama");
		expect(helpers.DEFAULT_LLM.dictation.model).toBe("");
		expect(helpers.DEFAULT_LLM.dictation.presets).toEqual([{ key: "neutral" }]);
		expect(helpers.DEFAULT_LLM.transforms.enabled).toBe(false);
		expect(helpers.DEFAULT_LLM.transforms.provider).toBe("ollama");
		expect(helpers.DEFAULT_LLM.transforms.model).toBe("");
	});

	test("DEFAULT_FEATURE is the shared per-feature baseline (no presets)", () => {
		expect(helpers.DEFAULT_FEATURE).toEqual({
			enabled: false,
			provider: "ollama",
			model: "",
			openrouterModel: "",
			openrouterFallbackModel: "",
			reasoningEffort: "medium",
			verbosity: "medium",
			maxOutputTokens: null,
		});
	});
});

describe("LlmSettingsPanel helpers — readFeatureSnapshot", () => {
	test("returns DEFAULT_FEATURE when input is null", () => {
		expect(helpers.readFeatureSnapshot(null)).toEqual(helpers.DEFAULT_FEATURE);
	});

	test("merges partial feature settings over the feature defaults", () => {
		const snap = helpers.readFeatureSnapshot({ provider: "openrouter", enabled: true });
		expect(snap.provider).toBe("openrouter");
		expect(snap.enabled).toBe(true);
		expect(snap.model).toBe("");
		expect(snap.openrouterModel).toBe("");
	});
});

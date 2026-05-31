import { describe, expect, mock, test } from "bun:test";
import { asInvalid } from "@test/lib/cast";
import { render } from "@testing-library/react";
import type { useTranslations } from "use-intl";
import { IntlProvider } from "@/app/providers/IntlProvider";
import {
	type FeatureToggleDeps,
	__llm_settings_panel_test_helpers__ as helpers,
} from "../lib/llm-settings-panel-test-helpers";
import { LlmSettingsPanel } from "./LlmSettingsPanel";

type TranslateFn = ReturnType<typeof useTranslations>;
// `readLlmSnapshot` accepts a forgiving partial input at runtime (it re-defaults
// missing fields), but its TS signature is the strict shape. Derive the param
// type to feed partial fixtures via a Partial<> cast at the boundary.
type LlmSettings = NonNullable<Parameters<typeof helpers.readLlmSnapshot>[0]>;

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
	vars ? `${key}:${JSON.stringify(vars)}` : key) as unknown as TranslateFn;

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
			// Partial feature blob — `readLlmSnapshot` re-defaults each missing
			// field at runtime; the TS signature reflects the strict shape so
			// the test fixture casts through the per-feature shape.
			dictation: { provider: "openrouter" } as LlmSettings["dictation"],
		} as Partial<LlmSettings>);
		expect(snap.dictation.provider).toBe("openrouter");
		expect(snap.openrouterApiKey).toBe("sk-test");
		expect(snap.endpoint).toBe(helpers.DEFAULT_LLM.endpoint);
		// Transforms defaults remain untouched
		expect(snap.transforms.provider).toBe("ollama");
		expect(snap.transforms.enabled).toBe(false);
	});
});

describe("LlmSettingsPanel helpers — buildToneOpts / buildLevelOpts", () => {
	test("buildToneOpts returns the four tone entries with stable order", () => {
		const opts = helpers.buildToneOpts(tStub);
		expect(opts.map((o) => o.value)).toEqual(["neutral", "formal", "friendly", "technical"]);
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

describe("LlmSettingsPanel helpers — toggleIndependent translate branch", () => {
	test("toggleIndependent adds translate entry with the default target language", () => {
		// Exercises makeIndependentEntry's translate branch, which carries the
		// targetLang invariant required by the translate preset path.
		const out = helpers.toggleIndependent([{ key: "neutral" }], "translate", true);
		const translate = out.find((p) => p.key === "translate");
		expect(translate).toBeDefined();
		expect((translate as { targetLang?: string }).targetLang).toBeDefined();
	});

	test("toggleIndependent adds translate entry with a custom target language", () => {
		// Confirms the targetLangOverride parameter threads through to the
		// translate entry without being clobbered by the default fallback.
		const out = helpers.toggleIndependent([], "translate", true, undefined, "fr");
		expect(out).toContainEqual({ key: "translate", targetLang: "fr" });
	});
});

describe("LlmSettingsPanel helpers — presets array mutators", () => {
	test("getToneKey returns 'neutral' for empty list", () => {
		expect(helpers.getToneKey([])).toBe("neutral");
	});

	test("setTone replaces the existing tone", () => {
		const out = helpers.setTone([{ key: "formal" }, { key: "summarize" }], "friendly");
		expect(out.find((p) => p.key === "friendly")).toBeDefined();
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
	test("returns ollama and openrouter providers by default (Windows/Linux)", () => {
		const opts = helpers.buildProviderOpts(tStub);
		expect(opts.map((o) => o.value)).toEqual(["ollama", "openrouter"]);
	});

	test("provider labels are non-empty", () => {
		const opts = helpers.buildProviderOpts(tStub);
		for (const opt of opts) {
			expect(opt.label.length).toBeGreaterThan(0);
		}
	});

	test("appends Apple Intelligence on Apple Silicon", () => {
		const opts = helpers.buildProviderOpts(tStub, { appleIntelligenceSupported: true });
		expect(opts.map((o) => o.value)).toEqual(["ollama", "openrouter", "apple-intelligence"]);
		const apple = opts.find((o) => o.value === "apple-intelligence");
		expect(apple?.disabled).toBeUndefined();
	});

	test("appends disabled Apple Intelligence with tooltip on Intel Macs", () => {
		const opts = helpers.buildProviderOpts(tStub, {
			appleIntelligenceUnavailableOnIntel: true,
		});
		const apple = opts.find((o) => o.value === "apple-intelligence");
		expect(apple?.disabled).toBe(true);
		expect(typeof apple?.disabledTooltip).toBe("string");
		expect((apple?.disabledTooltip ?? "").length).toBeGreaterThan(0);
	});

	test("omits Apple Intelligence entirely when neither platform flag is set", () => {
		const opts = helpers.buildProviderOpts(tStub, {});
		expect(opts.some((o) => o.value === "apple-intelligence")).toBe(false);
	});

	test("locks the OpenRouter option (disabled + lock badge) when no key is configured", () => {
		// Parity with the STT Source "Cloud" option: with no OpenRouter key the
		// cloud LLM provider must be DISABLED, not merely hinted — otherwise it
		// stays selectable after the user removes their key.
		const opts = helpers.buildProviderOpts(tStub, { openrouterNeedsKey: true });
		const openrouter = opts.find((o) => o.value === "openrouter");
		expect(openrouter?.disabled).toBe(true);
		expect(openrouter?.badgeIcon).toBeDefined();
		expect(openrouter?.badgeTooltipFooter).toBe("openrouterApiKeyTooltip");
	});

	test("leaves the OpenRouter option enabled once a key is present", () => {
		const opts = helpers.buildProviderOpts(tStub, { openrouterNeedsKey: false });
		const openrouter = opts.find((o) => o.value === "openrouter");
		expect(openrouter?.disabled).toBeUndefined();
		expect(openrouter?.badgeIcon).toBeUndefined();
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

	test("returns null when current model is empty (user mid-selection)", () => {
		// Regression test for the Ollama swap-wipe bug: a duplicate Combobox
		// callback transiently set the model to undefined; this function used
		// to interpret that as "find any replacement" and pick the first
		// model, which happened to match the previously-selected value,
		// silently reverting the user's swap. We now skip replacement when
		// `current` is empty so the user's deliberate pick takes priority.
		expect(helpers.pickReplacementOllamaModel([{ name: "a" }, { name: "b" }], "")).toBeNull();
	});

	test("returns null when current model is undefined (loose runtime input)", () => {
		// TypeScript narrows `current` to `string`, but at runtime a transient
		// undefined can still pass through (Zustand patches model: undefined).
		// The implementation guards on falsy-current to cover both cases.
		expect(
			helpers.pickReplacementOllamaModel([{ name: "a" }], asInvalid<string>(undefined))
		).toBeNull();
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

// Tests assert on the `mock(...)`-returned spies; the helper signature accepts
// regular functions. Intersect the spy types onto the strict deps shape so
// individual call-sites are properly typed without loosening the helper
// contract.
type ToggleDepsForTest = FeatureToggleDeps & {
	apply: ReturnType<typeof mock>;
	checkOllamaReachable: ReturnType<typeof mock>;
	scanOllama: ReturnType<typeof mock>;
	scanOpenRouter: ReturnType<typeof mock>;
	setShowApiKeyDialog: ReturnType<typeof mock>;
	setShowModelPicker: ReturnType<typeof mock>;
	setShowOllamaDialog: ReturnType<typeof mock>;
};

function makeDeps(overrides: Partial<ToggleDepsForTest> = {}): ToggleDepsForTest {
	return {
		provider: "ollama",
		openrouterApiKey: "",
		ollamaLoaded: false,
		ollamaModels: [],
		openrouterLoaded: false,
		currentOllamaModel: "",
		currentOpenRouterModel: "",
		checkOllamaReachable: mock(() => Promise.resolve(true)),
		scanOllama: mock(() => undefined),
		scanOpenRouter: mock(() => undefined),
		apply: mock(() => undefined),
		setShowOllamaDialog: mock(() => undefined),
		setShowApiKeyDialog: mock(() => undefined),
		setShowModelPicker: mock(() => undefined),
		...overrides,
	};
}

describe("LlmSettingsPanel helpers — pickSmallestInstalledOllama", () => {
	test("returns null when no models installed", () => {
		expect(helpers.pickSmallestInstalledOllama([])).toBeNull();
	});

	test("picks the smallest by size", () => {
		const out = helpers.pickSmallestInstalledOllama([
			{ name: "big", size: 3_000_000_000 },
			{ name: "tiny", size: 270_000_000 },
			{ name: "mid", size: 1_200_000_000 },
		]);
		expect(out).toBe("tiny");
	});

	test("treats missing size as 0 (returns first such entry)", () => {
		const out = helpers.pickSmallestInstalledOllama([
			{ name: "sized", size: 500 },
			{ name: "unsized" },
		]);
		expect(out).toBe("unsized");
	});
});

describe("LlmSettingsPanel helpers — tryEnableOllamaForFeature", () => {
	test("opens dialog when Ollama is unreachable", async () => {
		const deps = makeDeps({
			checkOllamaReachable: mock(() => Promise.resolve(false)),
		});
		await helpers.tryEnableOllamaForFeature(deps);
		expect(deps.setShowOllamaDialog).toHaveBeenCalledWith(true);
		expect(deps.apply).not.toHaveBeenCalled();
	});

	test("opens the model picker when reachable but no models installed", async () => {
		const deps = makeDeps({ ollamaLoaded: true });
		await helpers.tryEnableOllamaForFeature(deps);
		// No model to pick — must NOT silently enable with model: "". Instead the
		// picker opens so the user can download one; `enabled` is committed by the
		// picker's install callback (not here), and the install/run dialog stays
		// out of it since Ollama is already reachable.
		expect(deps.apply).not.toHaveBeenCalled();
		expect(deps.setShowModelPicker).toHaveBeenCalledWith(true);
		expect(deps.setShowOllamaDialog).not.toHaveBeenCalled();
	});

	test("auto-picks smallest installed when current model is empty", async () => {
		const deps = makeDeps({
			ollamaLoaded: true,
			currentOllamaModel: "",
			ollamaModels: [
				{ name: "big", size: 3_000_000_000 },
				{ name: "tiny", size: 270_000_000 },
			],
		});
		await helpers.tryEnableOllamaForFeature(deps);
		expect(deps.apply).toHaveBeenCalledWith({ model: "tiny", enabled: true });
	});

	test("keeps current model when it's still installed", async () => {
		const deps = makeDeps({
			ollamaLoaded: true,
			currentOllamaModel: "big",
			ollamaModels: [
				{ name: "big", size: 3_000_000_000 },
				{ name: "tiny", size: 270_000_000 },
			],
		});
		await helpers.tryEnableOllamaForFeature(deps);
		expect(deps.apply).toHaveBeenCalledWith({ enabled: true });
	});

	test("replaces current model when it's no longer installed", async () => {
		const deps = makeDeps({
			ollamaLoaded: true,
			currentOllamaModel: "deleted-model",
			ollamaModels: [{ name: "tiny", size: 270_000_000 }],
		});
		await helpers.tryEnableOllamaForFeature(deps);
		expect(deps.apply).toHaveBeenCalledWith({ model: "tiny", enabled: true });
	});

	test("scans when not yet loaded", async () => {
		const deps = makeDeps({
			currentOllamaModel: "tiny",
			ollamaModels: [{ name: "tiny", size: 270_000_000 }],
		});
		await helpers.tryEnableOllamaForFeature(deps);
		expect(deps.scanOllama).toHaveBeenCalledTimes(1);
		expect(deps.apply).toHaveBeenCalledWith({ enabled: true });
	});
});

describe("LlmSettingsPanel helpers — tryEnableOpenRouterForFeature", () => {
	test("opens api key dialog when key missing", () => {
		const deps = makeDeps({ provider: "openrouter" });
		helpers.tryEnableOpenRouterForFeature(deps);
		expect(deps.setShowApiKeyDialog).toHaveBeenCalledWith(true);
		expect(deps.apply).not.toHaveBeenCalled();
	});

	test("auto-picks hardcoded default when no model selected", () => {
		const deps = makeDeps({
			provider: "openrouter",
			openrouterApiKey: "k",
			openrouterLoaded: true,
			currentOpenRouterModel: "",
		});
		helpers.tryEnableOpenRouterForFeature(deps);
		expect(deps.apply).toHaveBeenCalledWith({
			openrouterModel: helpers.DEFAULT_OPENROUTER_MODEL,
			enabled: true,
		});
	});

	test("keeps user's model when one is already selected", () => {
		const deps = makeDeps({
			provider: "openrouter",
			openrouterApiKey: "k",
			openrouterLoaded: true,
			currentOpenRouterModel: "anthropic/claude-3.5-sonnet",
		});
		helpers.tryEnableOpenRouterForFeature(deps);
		expect(deps.apply).toHaveBeenCalledWith({ enabled: true });
	});

	test("scans when key present and not loaded", () => {
		const deps = makeDeps({ provider: "openrouter", openrouterApiKey: "k" });
		helpers.tryEnableOpenRouterForFeature(deps);
		expect(deps.scanOpenRouter).toHaveBeenCalled();
		expect(deps.apply).toHaveBeenCalled();
	});

	test("skips scan when already loaded", () => {
		const deps = makeDeps({
			provider: "openrouter",
			openrouterApiKey: "k",
			openrouterLoaded: true,
		});
		helpers.tryEnableOpenRouterForFeature(deps);
		expect(deps.scanOpenRouter).not.toHaveBeenCalled();
		expect(deps.apply).toHaveBeenCalled();
	});
});

describe("LlmSettingsPanel helpers — performFeatureToggle", () => {
	test("disables without provider checks when next is false", async () => {
		const deps = makeDeps();
		await helpers.performFeatureToggle(false, deps);
		expect(deps.apply).toHaveBeenCalledWith({ enabled: false });
		expect(deps.checkOllamaReachable).not.toHaveBeenCalled();
	});

	test("delegates to ollama enable path when provider=ollama", async () => {
		const deps = makeDeps({ provider: "ollama" });
		await helpers.performFeatureToggle(true, deps);
		expect(deps.checkOllamaReachable).toHaveBeenCalled();
	});

	test("delegates to openrouter enable path when provider=openrouter", async () => {
		const deps = makeDeps({ provider: "openrouter" });
		await helpers.performFeatureToggle(true, deps);
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
			thinkingEffort: "medium",
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

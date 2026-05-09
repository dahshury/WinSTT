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
		const snap = helpers.readLlmSnapshot({
			provider: "openrouter",
			openrouterApiKey: "sk-test",
		});
		expect(snap.provider).toBe("openrouter");
		expect(snap.openrouterApiKey).toBe("sk-test");
		expect(snap.endpoint).toBe(helpers.DEFAULT_LLM.endpoint);
	});
});

describe("LlmSettingsPanel helpers — buildOllamaModelOpts", () => {
	test("formats name and size as GB", () => {
		const opts = helpers.buildOllamaModelOpts([{ name: "llama3", size: 4_500_000_000 }]);
		expect(opts).toEqual([{ id: "llama3", label: "llama3 (4.5 GB)" }]);
	});

	test("uses 0 GB when size is missing", () => {
		const opts = helpers.buildOllamaModelOpts([{ name: "phi" }]);
		expect(opts[0]).toEqual({ id: "phi", label: "phi (0.0 GB)" });
	});
});

describe("LlmSettingsPanel helpers — buildPresetOpts", () => {
	test("returns 6 preset entries with stable values", () => {
		const opts = helpers.buildPresetOpts(tStub);
		expect(opts).toHaveLength(6);
		expect(opts.map((o) => o.value)).toEqual([
			"neutral",
			"formal",
			"friendly",
			"technical",
			"casual",
			"concise",
		]);
	});

	test("each preset has a label string and an icon", () => {
		const opts = helpers.buildPresetOpts(tStub);
		for (const opt of opts) {
			expect(typeof opt.label).toBe("string");
			expect(opt.icon).toBeDefined();
		}
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
	setShowApiKeyDialog: ReturnType<typeof mock>;
	setShowOllamaDialog: ReturnType<typeof mock>;
	update: ReturnType<typeof mock>;
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
		update: mock(() => undefined),
		setShowOllamaDialog: mock(() => undefined),
		setShowApiKeyDialog: mock(() => undefined),
		...overrides,
	};
}

describe("LlmSettingsPanel helpers — tryEnableOllama", () => {
	test("opens dialog when Ollama is unreachable", async () => {
		const deps = makeDeps({
			checkOllamaReachable: mock(() => Promise.resolve(false)),
		});
		await helpers.tryEnableOllama(deps as any);
		expect(deps.setShowOllamaDialog).toHaveBeenCalledWith(true);
		expect(deps.update).not.toHaveBeenCalled();
	});

	test("scans and enables when reachable and not yet loaded", async () => {
		const deps = makeDeps();
		await helpers.tryEnableOllama(deps as any);
		expect(deps.scanOllama).toHaveBeenCalledTimes(1);
		expect(deps.update).toHaveBeenCalledWith({ enabled: true });
	});

	test("skips scan when already loaded", async () => {
		const deps = makeDeps({ ollamaLoaded: true });
		await helpers.tryEnableOllama(deps as any);
		expect(deps.scanOllama).not.toHaveBeenCalled();
		expect(deps.update).toHaveBeenCalledWith({ enabled: true });
	});
});

describe("LlmSettingsPanel helpers — tryEnableOpenRouter", () => {
	test("opens api key dialog when key missing", () => {
		const deps = makeDeps({ provider: "openrouter" });
		helpers.tryEnableOpenRouter(deps as any);
		expect(deps.setShowApiKeyDialog).toHaveBeenCalledWith(true);
		expect(deps.update).not.toHaveBeenCalled();
	});

	test("enables and scans when key present and not loaded", () => {
		const deps = makeDeps({ provider: "openrouter", openrouterApiKey: "k" });
		helpers.tryEnableOpenRouter(deps as any);
		expect(deps.scanOpenRouter).toHaveBeenCalled();
		expect(deps.update).toHaveBeenCalledWith({ enabled: true });
	});

	test("skips scan when already loaded", () => {
		const deps = makeDeps({
			provider: "openrouter",
			openrouterApiKey: "k",
			openrouterLoaded: true,
		});
		helpers.tryEnableOpenRouter(deps as any);
		expect(deps.scanOpenRouter).not.toHaveBeenCalled();
		expect(deps.update).toHaveBeenCalledWith({ enabled: true });
	});
});

describe("LlmSettingsPanel helpers — performToggle", () => {
	test("disables without provider checks when next is false", async () => {
		const deps = makeDeps();
		await helpers.performToggle(false, deps as any);
		expect(deps.update).toHaveBeenCalledWith({ enabled: false });
		expect(deps.checkOllamaReachable).not.toHaveBeenCalled();
	});

	test("delegates to ollama enable path when provider=ollama", async () => {
		const deps = makeDeps({ provider: "ollama" });
		await helpers.performToggle(true, deps as any);
		expect(deps.checkOllamaReachable).toHaveBeenCalled();
	});

	test("delegates to openrouter enable path when provider=openrouter", async () => {
		const deps = makeDeps({ provider: "openrouter" });
		await helpers.performToggle(true, deps as any);
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

describe("LlmSettingsPanel helpers — DEFAULT_LLM", () => {
	test("contains expected baseline values", () => {
		expect(helpers.DEFAULT_LLM.enabled).toBe(false);
		expect(helpers.DEFAULT_LLM.provider).toBe("ollama");
		expect(helpers.DEFAULT_LLM.endpoint).toBe("http://localhost:11434");
	});
});

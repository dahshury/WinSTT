import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { asInvalid } from "@test/lib/cast";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useLlmCatalogStore } from "@/entities/llm-catalog";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useLlmModelPickerStore } from "@/features/llm-model-picker";
import type { TranslateFn } from "@/shared/i18n/translation-types";
import * as helpers from "../lib/llm-settings-panel-test-helpers";
import type { FeatureToggleDeps } from "../lib/llm-settings-panel-test-helpers";
import {
	DEFAULT_CONFIGURATION_ID,
	type LlmConfiguration,
	type SavedConfiguration,
	useLlmConfigurationsStore,
} from "../model/configurations";
import { useSmartEndpointDisabledNoticeStore } from "../model/use-llm-settings-panel";
import { useWarmupStatusStore } from "../model/warmup-status-store";
import { LlmSettingsPanel } from "./LlmSettingsPanel";

// `readLlmSnapshot` accepts a forgiving partial input at runtime (it re-defaults
// missing fields), but its TS signature is the strict shape. Derive the param
// type to feed partial fixtures via a Partial<> cast at the boundary.
type LlmSettings = NonNullable<Parameters<typeof helpers.readLlmSnapshot>[0]>;

beforeEach(() => {
	useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
	useLlmConfigurationsStore.setState({
		activeConfigurationId: null,
		configurations: [],
	});
	// The Ollama catalog drives the reconcile effect that can disable a local
	// feature out from under a test, so it is reset alongside the other stores —
	// a leftover installed model from a previous test changes the outcome here.
	useLlmCatalogStore.setState({ isLoaded: false, models: [] });
	// Both are process-global singletons: a leaked warm-up failure paints banners
	// onto an unrelated test's rows, and a leaked picker session makes the
	// read-aloud routing assertion pass for the wrong reason.
	useWarmupStatusStore.setState({ status: null });
	useLlmModelPickerStore.setState({
		enableOnInstall: false,
		feature: null,
		open: false,
		pendingFeature: null,
	});
	// Enabling dictation legitimately raises this toast (Smart Endpoint is
	// mutually exclusive with it), and the store is a process-global singleton —
	// left set, it renders into an unrelated test file's fixture.
	useSmartEndpointDisabledNoticeStore.getState().clear();
});

afterEach(() => {
	useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
	useLlmConfigurationsStore.setState({
		activeConfigurationId: null,
		configurations: [],
	});
	useLlmCatalogStore.setState({ isLoaded: false, models: [] });
	useWarmupStatusStore.setState({ status: null });
	useLlmModelPickerStore.setState({
		enableOnInstall: false,
		feature: null,
		open: false,
		pendingFeature: null,
	});
	// Enabling dictation legitimately raises this toast (Smart Endpoint is
	// mutually exclusive with it), and the store is a process-global singleton —
	// left set, it renders into an unrelated test file's fixture.
	useSmartEndpointDisabledNoticeStore.getState().clear();
});

function savedConfiguration(
	id: string,
	name: string,
	patch: Partial<LlmConfiguration>,
): SavedConfiguration {
	const base = DEFAULT_SETTINGS.llm.dictation;
	return {
		id,
		name,
		config: {
			customModifiers: base.customModifiers.map((m) => ({ ...m })),
			enabled: base.enabled,
			maxOutputTokens: base.maxOutputTokens,
			model: base.model,
			openrouterFallbackModel: base.openrouterFallbackModel,
			openrouterModel: base.openrouterModel,
			presets: base.presets.map((p) => ({ ...p })),
			provider: base.provider,
			reasoningEffort: base.reasoningEffort,
			thinkingEffort: base.thinkingEffort,
			verbosity: base.verbosity,
			...patch,
		},
	};
}

/** Two saved configurations, with the first assigned to every feature — the
 *  normal state, since the app seeds built-ins on first load. */
function seedConfigurations(patch: Partial<LlmConfiguration> = {}): void {
	useLlmConfigurationsStore.setState({
		activeConfigurationId: "first",
		configurations: [
			savedConfiguration("first", "First", patch),
			savedConfiguration("second", "Second", {
				...patch,
				presets: [{ key: "technical" }],
			}),
		],
	});
	const llm = useSettingsStore.getState().settings.llm;
	useSettingsStore.setState({
		settings: {
			...useSettingsStore.getState().settings,
			llm: {
				...llm,
				dictation: { ...llm.dictation, ...patch, configurationId: "first" },
				transforms: { ...llm.transforms, ...patch, configurationId: "first" },
				readAloud: { ...llm.readAloud, ...patch, configurationId: "first" },
			},
		},
	});
}

/** The three consumers, by the label the rows and the editor both use. */
const FEATURE_NAMES = ["Dictation", "Transformations", "Read aloud"] as const;

/** One consumer's enable switch (WHETHER it runs). Every row renders one, on or
 *  off — there is no separate chip strip any more, so this is unambiguous
 *  document-wide. */
function featureSwitch(name: string): HTMLElement {
	return screen.getByRole("switch", { name: `Turn ${name} on or off` });
}

/** The per-feature profile picker (WHICH profile that consumer runs). Scoped to
 *  the row's own group, because all three pickers are always mounted now. */
function profilePicker(name: string): HTMLElement {
	return within(screen.getByRole("group", { name })).getByRole("combobox");
}

/** Prev/next on one consumer's picker — they cycle THAT feature's profile. */
function profileArrow(
	name: string,
	direction: "Next" | "Previous",
): HTMLElement {
	return within(screen.getByRole("group", { name })).getByRole("button", {
		name: `${direction} profile`,
	});
}

/** Base UI's Switch renders a `<span role="switch">`, not a `<button>`, so there
 *  is no `disabled` DOM property to read — the blocked state shows up as
 *  `aria-disabled` (and is asserted behaviourally by clicking as well). */
function switchIsBlocked(name: string): boolean {
	return featureSwitch(name).getAttribute("aria-disabled") === "true";
}

/** Warm-up spinners badging the feature switches. Scoped to each switch's own
 *  `PendingBadge` wrapper (its direct parent): an unrelated catalog scan
 *  elsewhere on the page has its own spinner, which would make a document-wide
 *  query meaningless. */
function featureRowSpinners(): number {
	return FEATURE_NAMES.reduce((total, name) => {
		const badge = featureSwitch(name).parentElement;
		return total + (badge?.querySelectorAll(".animate-spin").length ?? 0);
	}, 0);
}

/** Which consumers' switches live in the nearest row-level ancestor of `el`.
 *  A feature EXTRA (dictionary auto-add, warm-up banner) must nest under its own
 *  row, so exactly one name comes back; a page-level sibling would sit in the
 *  container that holds all three and return all of them. */
function nearestFeatureScope(el: HTMLElement): string[] {
	for (let node = el.parentElement; node; node = node.parentElement) {
		const current = node;
		const owned = FEATURE_NAMES.filter((name) =>
			current.contains(featureSwitch(name)),
		);
		if (owned.length > 0) {
			return [...owned];
		}
	}
	return [];
}

/** A cloud configuration plus a key, used wherever a test is about the tab's own
 *  behaviour rather than the Ollama preflight: a LOCAL feature enabled with no
 *  installed model is immediately switched back off by the catalog reconcile,
 *  which would mask what the test is actually asserting. */
function seedCloudConfigurations(): void {
	seedConfigurations({
		openrouterModel: "vendor/fast",
		provider: "openrouter",
	});
	useSettingsStore.setState({
		settings: {
			...useSettingsStore.getState().settings,
			llm: {
				...useSettingsStore.getState().settings.llm,
				openrouterApiKey: "sk-test",
			},
		},
	});
}

function renderPanel() {
	return render(
		<IntlProvider>
			<LlmSettingsPanel />
		</IntlProvider>,
	);
}

describe("LlmSettingsPanel", () => {
	test("renders without crashing", () => {
		const { container } = renderPanel();
		expect(container.firstElementChild).not.toBeNull();
	});

	// Tone and modifiers define a PROFILE, so they live in the profile editor
	// (which is also where you try it) — never half-copied onto the tab.
	test("keeps tone and modifiers off the tab", () => {
		seedConfigurations();
		renderPanel();
		expect(screen.queryByText("Tone")).toBeNull();
		expect(screen.queryByText("Modifiers")).toBeNull();
	});

	test("the profile editor holds one copy of tone and modifiers", () => {
		seedConfigurations();
		renderPanel();
		fireEvent.click(screen.getByRole("button", { name: "Manage profiles" }));

		expect(screen.getAllByText("Tone")).toHaveLength(1);
		expect(screen.getAllByText("Modifiers")).toHaveLength(1);
		// Wide enough to hold all four `sm`-sized segments in one row without
		// clipping "Caveman" (see modifier-presets.tsx).
		const caveman = screen.getAllByText("Caveman")[0];
		const group = caveman?.closest("button")?.parentElement;
		expect(group?.className).toContain("w-[21rem]");
	});

	test("gives every consumer its own enable switch", () => {
		seedConfigurations();
		renderPanel();
		// Transformations in particular: it had no control of its own at all
		// before, because it silently shadowed dictation.
		for (const name of FEATURE_NAMES) {
			expect(featureSwitch(name).getAttribute("aria-checked")).toBe("false");
		}
	});

	// Every row is present whether or not its feature runs. Hiding the off ones
	// meant the tab could show nothing at all and needed an empty state to explain
	// itself — and it hid the very switch you came to find.
	test("renders all three rows when nothing is enabled", () => {
		seedConfigurations();
		renderPanel();
		for (const name of FEATURE_NAMES) {
			expect(featureSwitch(name)).not.toBeNull();
			expect(profilePicker(name)).not.toBeNull();
		}
		// No empty state, and no separate assignment section to send the user to.
		expect(
			screen.queryByText(
				"No mode is on. Turn one on above to give it a profile.",
			),
		).toBeNull();
		expect(screen.queryByText("Applies to")).toBeNull();
	});

	test("a switch writes only that feature's enabled flag", () => {
		seedCloudConfigurations();
		renderPanel();
		fireEvent.click(featureSwitch("Transformations"));
		const { llm } = useSettingsStore.getState().settings;
		expect(llm.transforms.enabled).toBe(true);
		// The old mirror would have dragged dictation along with it.
		expect(llm.dictation.enabled).toBe(false);
		expect(llm.readAloud.enabled).toBe(false);
	});

	// Multi-select: any combination is reachable, and each switch reports only its
	// own consumer. There is no master switch — one could only mean "any of
	// them", which either misreports what is running or needs an arbitrary rule
	// for what turning it on should start.
	test("the switches reflect which consumers are on, independently", () => {
		seedCloudConfigurations();
		const llm = useSettingsStore.getState().settings.llm;
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				llm: { ...llm, readAloud: { ...llm.readAloud, enabled: true } },
			},
		});
		renderPanel();
		expect(featureSwitch("Read aloud").getAttribute("aria-checked")).toBe(
			"true",
		);
		expect(featureSwitch("Dictation").getAttribute("aria-checked")).toBe(
			"false",
		);
		expect(featureSwitch("Transformations").getAttribute("aria-checked")).toBe(
			"false",
		);
	});

	// Turning OFF has to signal that the model is being unloaded from VRAM, which
	// only happens if the flow goes through the per-feature controller — a direct
	// `enabled: false` write skips `beginUnload` and the spinner never appears.
	test("turning a switch off routes through the controller so unload is signalled", async () => {
		// Cloud + key so the Ollama catalog reconcile can't disable the feature out
		// from under the click.
		seedCloudConfigurations();
		const llm = useSettingsStore.getState().settings.llm;
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				llm: { ...llm, dictation: { ...llm.dictation, enabled: true } },
			},
		});
		const seen: boolean[] = [];
		const spy = spyOn(helpers, "performFeatureToggle").mockImplementation(
			async (next: boolean, deps: FeatureToggleDeps) => {
				seen.push(next);
				deps.apply({ enabled: next });
				return Promise.resolve();
			},
		);
		renderPanel();
		fireEvent.click(featureSwitch("Dictation"));
		await Promise.resolve();

		expect(seen).toEqual([false]);
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
		spy.mockRestore();
	});

	test("turning one switch off leaves the other consumers running", () => {
		seedCloudConfigurations();
		const llm = useSettingsStore.getState().settings.llm;
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				llm: {
					...llm,
					dictation: { ...llm.dictation, enabled: true },
					readAloud: { ...llm.readAloud, enabled: true },
				},
			},
		});
		renderPanel();
		fireEvent.click(featureSwitch("Dictation"));
		const after = useSettingsStore.getState().settings.llm;
		expect(after.dictation.enabled).toBe(false);
		// Independent switches: turning one off is not a master-off.
		expect(after.readAloud.enabled).toBe(true);
	});

	// Every consumer ships assigned to "Default" (base cleanup, neutral tone), so
	// a feature is never enableable with nothing to run and the picker never shows
	// an empty "choose one" state.
	test("each consumer starts assigned to the shipped Default preset", () => {
		const { llm } = useSettingsStore.getState().settings;
		for (const feature of [llm.dictation, llm.transforms, llm.readAloud]) {
			expect(feature.configurationId).toBe(DEFAULT_CONFIGURATION_ID);
		}
	});

	test("a consumer cannot be enabled when no preset resolves at all", () => {
		// Configurations deleted down to nothing: enabling would arm a feature with
		// no prompt, so the row refuses and says why.
		useLlmConfigurationsStore.setState({
			activeConfigurationId: null,
			configurations: [],
		});
		renderPanel();
		fireEvent.click(featureSwitch("Dictation"));
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
		expect(switchIsBlocked("Dictation")).toBe(true);
	});

	// The preflight resolves the cloud model when the feature has none, and the
	// whole patch has to survive the commit: narrowing it to `{enabled, model}`
	// dropped `openrouterModel`, so the feature came on with nothing to call.
	test("enabling a cloud feature keeps the model the preflight resolved", async () => {
		seedCloudConfigurations();
		const llm = useSettingsStore.getState().settings.llm;
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				llm: {
					...llm,
					transforms: { ...llm.transforms, openrouterModel: "" },
				},
			},
		});
		const spy = spyOn(helpers, "performFeatureToggle").mockImplementation(
			async (_next: boolean, deps: FeatureToggleDeps) => {
				deps.apply({ openrouterModel: "vendor/default", enabled: true });
				return Promise.resolve();
			},
		);
		renderPanel();
		fireEvent.click(featureSwitch("Transformations"));
		await Promise.resolve();

		const after = useSettingsStore.getState().settings.llm.transforms;
		expect(after.enabled).toBe(true);
		expect(after.openrouterModel).toBe("vendor/default");
		spy.mockRestore();
	});

	// The heal re-resolves the feature from the RENDER-TIME context, so running it
	// after the model write overwrote the model the preflight had just picked —
	// with the stale shared model, or with "" for a preset that names none.
	test("healing a dangling assignment does not clobber the preflight's model", async () => {
		seedConfigurations();
		const llm = useSettingsStore.getState().settings.llm;
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				llm: {
					...llm,
					localModel: "",
					// Points at a configuration that was deleted, and no feature holds a
					// local model yet — so the heal has nothing but "" to resolve to.
					dictation: { ...llm.dictation, configurationId: "gone", model: "" },
				},
			},
		});
		useLlmCatalogStore.setState({
			isLoaded: true,
			models: [asInvalid({ name: "llama3.2:1b", size: 1 })],
		});
		const spy = spyOn(helpers, "performFeatureToggle").mockImplementation(
			async (_next: boolean, deps: FeatureToggleDeps) => {
				deps.apply({ model: "llama3.2:1b", enabled: true });
				return Promise.resolve();
			},
		);
		renderPanel();
		fireEvent.click(featureSwitch("Dictation"));
		await Promise.resolve();

		const after = useSettingsStore.getState().settings.llm.dictation;
		expect(after.enabled).toBe(true);
		expect(after.configurationId).toBe("first");
		// Never enabled with an empty model id — that is the state the preflight
		// exists to prevent, and the reconcile would switch the feature straight
		// back off.
		expect(after.model).toBe("llama3.2:1b");
		spy.mockRestore();
	});

	// One warm-up broadcast describes the DAEMON, not a consumer. With the shared
	// local model on (the default) every enabled row resolves to the same model,
	// so a per-row banner rendered the identical failure two or three times, each
	// with its own Retry button.
	test("shows one warm-up banner when several consumers share the failure", () => {
		seedConfigurations();
		const llm = useSettingsStore.getState().settings.llm;
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				llm: {
					...llm,
					localModel: "qwen3:4b",
					dictation: { ...llm.dictation, enabled: true, model: "qwen3:4b" },
					readAloud: { ...llm.readAloud, enabled: true, model: "qwen3:4b" },
				},
			},
		});
		useLlmCatalogStore.setState({
			isLoaded: true,
			models: [asInvalid({ name: "qwen3:4b", size: 1 })],
		});
		useWarmupStatusStore.setState({
			status: {
				endpoint: "http://localhost:11434",
				inProgress: false,
				models: [],
				ollamaInstalled: true,
				reachable: false,
				timestamp: 1,
			},
		});
		renderPanel();

		expect(screen.getAllByText("Ollama is not responding")).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Retry now" })).toHaveLength(
			1,
		);
	});

	// The banner names the consumer in its "install Ollama" copy. Read aloud used
	// to borrow dictation's name, so the banner under the Read aloud row read
	// "…to use the dictation model."
	test("the warm-up banner names the consumer it sits under", () => {
		seedConfigurations();
		const llm = useSettingsStore.getState().settings.llm;
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				llm: {
					...llm,
					localModel: "qwen3:4b",
					readAloud: { ...llm.readAloud, enabled: true, model: "qwen3:4b" },
				},
			},
		});
		useLlmCatalogStore.setState({
			isLoaded: true,
			models: [asInvalid({ name: "qwen3:4b", size: 1 })],
		});
		useWarmupStatusStore.setState({
			status: {
				endpoint: "http://localhost:11434",
				inProgress: false,
				models: [],
				ollamaInstalled: false,
				reachable: false,
				timestamp: 1,
			},
		});
		renderPanel();

		const banner = screen.getByText(/Install it to use the/);
		expect(banner.textContent).toContain("read aloud");
		expect(nearestFeatureScope(banner as HTMLElement)).toEqual(["Read aloud"]);
	});

	// The preflight dialogs commit `enabled`, so routing read aloud's through
	// dictation's turned DICTATION on when the user asked for read aloud.
	test("a read-aloud turn-on opens the picker for read aloud", async () => {
		seedConfigurations();
		const spy = spyOn(helpers, "performFeatureToggle").mockImplementation(
			async (_next: boolean, deps: FeatureToggleDeps) => {
				deps.setShowModelPicker(true);
				return Promise.resolve();
			},
		);
		renderPanel();
		fireEvent.click(featureSwitch("Read aloud"));
		await Promise.resolve();

		expect(useLlmModelPickerStore.getState().feature).toBe("readAloud");
		spy.mockRestore();
	});

	test("enabling heals an assignment whose preset no longer exists", () => {
		seedCloudConfigurations();
		const llm = useSettingsStore.getState().settings.llm;
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				llm: {
					...llm,
					// Points at a configuration that was deleted.
					transforms: { ...llm.transforms, configurationId: "gone" },
				},
			},
		});
		renderPanel();
		fireEvent.click(featureSwitch("Transformations"));
		const after = useSettingsStore.getState().settings.llm.transforms;
		expect(after.enabled).toBe(true);
		// Written down before the flag flipped — never enabled while dangling.
		expect(after.configurationId).toBe("first");
	});

	// Every locally-running consumer shares one model, so the SECOND one you
	// switch on loads nothing. Arming a warm-up spinner there would promise work
	// that never happens and then hang until its timeout, because no warmup
	// broadcast is coming.
	test("enabling a second consumer on the same model arms no warm-up", async () => {
		seedConfigurations();
		const llm = useSettingsStore.getState().settings.llm;
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				llm: {
					...llm,
					localModel: "qwen3:4b",
					// Dictation is already running the shared model.
					dictation: { ...llm.dictation, enabled: true, model: "qwen3:4b" },
					readAloud: { ...llm.readAloud, model: "qwen3:4b" },
				},
			},
		});
		// The model has to count as INSTALLED, or the catalog reconcile disables
		// dictation on mount and read-aloud legitimately becomes the first loader.
		useLlmCatalogStore.setState({
			isLoaded: true,
			models: [asInvalid({ name: "qwen3:4b", size: 1 })],
		});
		const spy = spyOn(helpers, "performFeatureToggle").mockImplementation(
			async (next: boolean, deps: FeatureToggleDeps) => {
				deps.apply({ enabled: next });
				return Promise.resolve();
			},
		);
		renderPanel();
		fireEvent.click(featureSwitch("Read aloud"));
		await Promise.resolve();

		expect(useSettingsStore.getState().settings.llm.readAloud.enabled).toBe(
			true,
		);
		// No pending badge on any row's switch: the model is already resident.
		expect(featureRowSpinners()).toBe(0);
		spy.mockRestore();
	});

	// Regression: a bare `enabled: true` write skipped the model preflight, so a
	// local feature could be switched on with an empty model id — nothing to load,
	// and the catalog reconcile then silently switched it back off. Enabling must
	// go through `performFeatureToggle`, which opens the picker instead.
	test("enabling a local feature with no model installed opens the picker, not an empty load", async () => {
		seedConfigurations();
		const openedPicker: boolean[] = [];
		const spy = spyOn(helpers, "performFeatureToggle").mockImplementation(
			async (next: boolean, deps: FeatureToggleDeps) => {
				openedPicker.push(next);
				// Stand in for the real preflight: no installed model → picker, and
				// crucially NO `enabled` commit.
				deps.setShowModelPicker(true);
				return Promise.resolve();
			},
		);
		renderPanel();
		fireEvent.click(featureSwitch("Dictation"));
		await Promise.resolve();

		expect(openedPicker).toEqual([true]);
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
		spy.mockRestore();
	});

	test("a switch routes ON through the model preflight", async () => {
		seedConfigurations();
		const calls: boolean[] = [];
		const spy = spyOn(helpers, "performFeatureToggle").mockImplementation(
			async (next: boolean) => {
				calls.push(next);
				return Promise.resolve();
			},
		);
		renderPanel();
		fireEvent.click(featureSwitch("Dictation"));
		await Promise.resolve();

		// It must not be a shortcut that writes `enabled` directly.
		expect(calls).toEqual([true]);
		spy.mockRestore();
	});

	test("Manage profiles opens the editor regardless of what is enabled", () => {
		renderPanel();
		const open = screen.getByRole("button", { name: "Manage profiles" });
		// Profiles are worth editing whether or not anything is running them.
		expect((open as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(open);
		// The editor's own tone row proves the modal mounted.
		expect(screen.getAllByText("Tone")).toHaveLength(1);
	});

	// Configure-then-enable is a normal order of operations, so an OFF feature's
	// picker stays live: the row dims its identity only, and the write lands.
	// Hiding the picker until the feature was on forced the reverse order.
	test("an off consumer still has a usable profile picker", () => {
		seedCloudConfigurations();
		renderPanel();
		// Read aloud is off and stays off — assigning a profile is not enabling.
		expect(featureSwitch("Read aloud").getAttribute("aria-checked")).toBe(
			"false",
		);
		expect((profilePicker("Read aloud") as HTMLInputElement).disabled).toBe(
			false,
		);
		fireEvent.click(profileArrow("Read aloud", "Next"));

		const after = useSettingsStore.getState().settings.llm;
		expect(after.readAloud.configurationId).toBe("second");
		expect(after.readAloud.enabled).toBe(false);
	});

	// The prev/next arrows sit on the per-feature picker, where they cycle THAT
	// feature's profile rather than a global "current preset".
	test("the per-feature picker steps that feature's profile", () => {
		seedCloudConfigurations();
		const llm = useSettingsStore.getState().settings.llm;
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				llm: { ...llm, dictation: { ...llm.dictation, enabled: true } },
			},
		});
		renderPanel();
		fireEvent.click(profileArrow("Dictation", "Next"));
		expect(
			useSettingsStore.getState().settings.llm.dictation.configurationId,
		).toBe("second");
		// Only dictation moved — the arrows are per feature.
		expect(
			useSettingsStore.getState().settings.llm.readAloud.configurationId,
		).toBe("first");
	});

	// Feature extras belong to their feature, not to the page: the dictionary
	// switch is a dictation-pipeline control, so it nests under dictation's row
	// and only while dictation is actually running on Ollama (tool-calling is an
	// Ollama capability).
	test("nests the dictionary auto-add control under a running Ollama dictation", () => {
		seedConfigurations();
		const { unmount } = renderPanel();
		expect(
			screen.queryByRole("switch", { name: "Auto-add dictionary words" }),
		).toBeNull();
		unmount();

		const llm = useSettingsStore.getState().settings.llm;
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				llm: {
					...llm,
					localModel: "qwen3:4b",
					dictation: { ...llm.dictation, enabled: true, model: "qwen3:4b" },
				},
			},
		});
		// Installed, so the reconcile leaves the enabled local feature alone.
		useLlmCatalogStore.setState({
			isLoaded: true,
			models: [asInvalid({ name: "qwen3:4b", size: 1 })],
		});
		renderPanel();
		const autoAdd = screen.getByRole("switch", {
			name: "Auto-add dictionary words",
		});
		expect(nearestFeatureScope(autoAdd)).toEqual(["Dictation"]);
	});

	test("forces LLM features off in listen mode without overwriting saved settings", () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				general: {
					...DEFAULT_SETTINGS.general,
					recordingMode: "listen",
				},
				llm: {
					...DEFAULT_SETTINGS.llm,
					openrouterApiKey: "sk-test",
					dictation: {
						...DEFAULT_SETTINGS.llm.dictation,
						enabled: true,
						openrouterModel: "openai/gpt-4o-mini",
						provider: "openrouter",
					},
					transforms: {
						...DEFAULT_SETTINGS.llm.transforms,
						enabled: true,
						openrouterModel: "openai/gpt-4o-mini",
						provider: "openrouter",
					},
				},
			} as typeof DEFAULT_SETTINGS,
		});
		const { unmount } = renderPanel();

		// Rows stay VISIBLE but inert — the disable-don't-hide rule — and the saved
		// settings underneath are untouched, so leaving listen mode restores
		// exactly what the user had. Asserted behaviourally on top of the
		// `aria-disabled` flag: the switch is a span with no `disabled` DOM
		// property, so clicking and observing no write is the real check (the same
		// shape `Toggle`'s own disabled test uses).
		for (const name of ["Dictation", "Transformations"]) {
			expect(switchIsBlocked(name)).toBe(true);
			fireEvent.click(featureSwitch(name));
		}
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			true,
		);
		expect(useSettingsStore.getState().settings.llm.transforms.enabled).toBe(
			true,
		);
		unmount();
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
		expect(opts.map((o) => o.value)).toEqual([
			"neutral",
			"formal",
			"friendly",
			"technical",
		]);
	});

	test("each tone option has a label and icon", () => {
		const opts = helpers.buildToneOpts(tStub);
		for (const opt of opts) {
			expect(typeof opt.label).toBe("string");
			expect(opt.icon).toBeDefined();
		}
	});

	test("buildLevelOpts returns light/medium/high/caveman", () => {
		const opts = helpers.buildLevelOpts(tStub);
		expect(opts.map((o) => o.value)).toEqual([
			"light",
			"medium",
			"high",
			"caveman",
		]);
	});
});

describe("LlmSettingsPanel helpers — toggleIndependent translate branch", () => {
	test("toggleIndependent adds translate entry with the default target language", () => {
		// Exercises makeIndependentEntry's translate branch, which carries the
		// targetLang invariant required by the translate preset path.
		const out = helpers.toggleIndependent(
			[{ key: "neutral" }],
			"translate",
			true,
		);
		const translate = out.find((p) => p.key === "translate");
		expect(translate).toBeDefined();
		expect((translate as { targetLang?: string }).targetLang).toBeDefined();
	});

	test("toggleIndependent adds translate entry with a custom target language", () => {
		// Confirms the targetLangOverride parameter threads through to the
		// translate entry without being clobbered by the default fallback.
		const out = helpers.toggleIndependent(
			[],
			"translate",
			true,
			undefined,
			"fr",
		);
		expect(out).toContainEqual({ key: "translate", targetLang: "fr" });
	});
});

describe("LlmSettingsPanel helpers — presets array mutators", () => {
	test("getToneKey returns 'neutral' for empty list", () => {
		expect(helpers.getToneKey([])).toBe("neutral");
	});

	test("setTone replaces the existing tone", () => {
		const out = helpers.setTone(
			[{ key: "formal" }, { key: "summarize" }],
			"friendly",
		);
		expect(out.find((p) => p.key === "friendly")).toBeDefined();
		expect(out.find((p) => p.key === "formal")).toBeUndefined();
		expect(out.find((p) => p.key === "summarize")).toBeDefined();
	});

	test("toggleIndependent adds with default level for leveled presets", () => {
		const out = helpers.toggleIndependent(
			[{ key: "neutral" }],
			"summarize",
			true,
		);
		expect(out).toContainEqual({ key: "summarize", level: "medium" });
	});

	test("toggleIndependent adds without level for non-leveled presets", () => {
		const out = helpers.toggleIndependent(
			[{ key: "neutral" }],
			"reorder",
			true,
		);
		expect(out).toContainEqual({ key: "reorder" });
	});

	test("toggleIndependent removes when set false", () => {
		const out = helpers.toggleIndependent(
			[{ key: "neutral" }, { key: "summarize", level: "high" }],
			"summarize",
			false,
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
			"high",
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
		const opts = helpers.buildProviderOpts(tStub, {
			appleIntelligenceSupported: true,
		});
		expect(opts.map((o) => o.value)).toEqual([
			"ollama",
			"openrouter",
			"apple-intelligence",
		]);
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
		const opts = helpers.buildProviderOpts(tStub, {
			openrouterNeedsKey: false,
		});
		const openrouter = opts.find((o) => o.value === "openrouter");
		expect(openrouter?.disabled).toBeUndefined();
		expect(openrouter?.badgeIcon).toBeUndefined();
	});
});

describe("LlmSettingsPanel helpers — pickReplacementOllamaModel", () => {
	test("returns null when current model is still installed", () => {
		expect(
			helpers.pickReplacementOllamaModel([{ name: "a" }, { name: "b" }], "a"),
		).toBeNull();
	});

	test("returns first model when current is missing", () => {
		expect(helpers.pickReplacementOllamaModel([{ name: "x" }], "missing")).toBe(
			"x",
		);
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
		expect(
			helpers.pickReplacementOllamaModel([{ name: "a" }, { name: "b" }], ""),
		).toBeNull();
	});

	test("returns null when current model is undefined (loose runtime input)", () => {
		// TypeScript narrows `current` to `string`, but at runtime a transient
		// undefined can still pass through (Zustand patches model: undefined).
		// The implementation guards on falsy-current to cover both cases.
		expect(
			helpers.pickReplacementOllamaModel(
				[{ name: "a" }],
				asInvalid<string>(undefined),
			),
		).toBeNull();
	});
});

describe("LlmSettingsPanel helpers — shouldSyncOllamaModel", () => {
	test("returns null when provider is not ollama", () => {
		expect(
			helpers.shouldSyncOllamaModel("openrouter", [{ name: "a" }], "z"),
		).toBeNull();
	});

	test("returns replacement when provider is ollama and current model missing", () => {
		expect(helpers.shouldSyncOllamaModel("ollama", [{ name: "a" }], "z")).toBe(
			"a",
		);
	});
});

describe("LlmSettingsPanel helpers — shouldScanOpenRouter", () => {
	const cases: [string, string, boolean, boolean][] = [
		["openrouter", "key", false, true],
		["openrouter", "", false, false],
		["openrouter", "key", true, false],
		["ollama", "key", false, false],
	];
	test.each(
		cases,
	)("provider=%s key=%s loaded=%s -> %s", (provider, key, loaded, expected) => {
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

function makeDeps(
	overrides: Partial<ToggleDepsForTest> = {},
): ToggleDepsForTest {
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

describe("LlmSettingsPanel helpers — resolveOllamaModelReconcilePatch", () => {
	test("returns null for non-Ollama providers", () => {
		expect(
			helpers.resolveOllamaModelReconcilePatch(
				"openrouter",
				[],
				"missing",
				true,
			),
		).toBeNull();
	});

	test("returns null when the current Ollama model is still installed", () => {
		expect(
			helpers.resolveOllamaModelReconcilePatch(
				"ollama",
				[{ name: "llama3", size: 1 }],
				"llama3",
				true,
			),
		).toBeNull();
	});

	test("replaces a stale Ollama model when another installed model exists", () => {
		expect(
			helpers.resolveOllamaModelReconcilePatch(
				"ollama",
				[{ name: "phi", size: 1 }],
				"deleted",
				true,
			),
		).toEqual({ model: "phi" });
	});

	test("disables an enabled Ollama feature when no models remain", () => {
		expect(
			helpers.resolveOllamaModelReconcilePatch("ollama", [], "deleted", true),
		).toEqual({ model: "", enabled: false });
	});

	test("switches enabled Ollama feature to OpenRouter when no local models remain and cloud is configured", () => {
		expect(
			helpers.resolveOllamaModelReconcilePatch(
				"ollama",
				[],
				"deleted",
				true,
				"sk-or-test",
				"",
			),
		).toEqual({
			enabled: true,
			model: "",
			openrouterModel: helpers.DEFAULT_OPENROUTER_MODEL,
			provider: "openrouter",
		});
	});

	test("preserves existing OpenRouter model when falling back to cloud", () => {
		expect(
			helpers.resolveOllamaModelReconcilePatch(
				"ollama",
				[],
				"deleted",
				true,
				"sk-or-test",
				"anthropic/claude-sonnet-4",
			),
		).toEqual({
			enabled: true,
			model: "",
			openrouterModel: "anthropic/claude-sonnet-4",
			provider: "openrouter",
		});
	});

	test("does not patch an already-disabled empty Ollama selection", () => {
		expect(
			helpers.resolveOllamaModelReconcilePatch("ollama", [], "", false),
		).toBeNull();
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

	test("enables a configured model on first toggle before the catalog scan resolves", async () => {
		// Real first-toggle state: the catalog hasn't been scanned yet, so its
		// snapshot is genuinely empty (NOT pre-populated). The configured model is
		// installed in Ollama, but the un-awaited scan hasn't surfaced it here. The
		// toggle must still commit `enabled: true` (kick off the scan, trust the
		// configured model) — not bounce to the picker and leave post-processing
		// off (the "VRAM never changes / Ollama never loads" report).
		const deps = makeDeps({
			ollamaLoaded: false,
			ollamaModels: [],
			currentOllamaModel: "gemma3:4b",
		});
		await helpers.tryEnableOllamaForFeature(deps);
		expect(deps.scanOllama).toHaveBeenCalledTimes(1);
		expect(deps.apply).toHaveBeenCalledWith({ enabled: true });
		expect(deps.setShowModelPicker).not.toHaveBeenCalled();
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

	test("enables Apple Intelligence without an Ollama model or cloud key", async () => {
		const deps = makeDeps({ provider: "apple-intelligence" });
		await helpers.performFeatureToggle(true, deps);
		expect(deps.apply).toHaveBeenCalledWith({ enabled: true });
		expect(deps.checkOllamaReachable).not.toHaveBeenCalled();
		expect(deps.setShowApiKeyDialog).not.toHaveBeenCalled();
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
		expect(helpers.DEFAULT_LLM.dictation.dictionaryAutoAddEnabled).toBe(false);
		expect(helpers.DEFAULT_LLM.dictation.provider).toBe("ollama");
		expect(helpers.DEFAULT_LLM.dictation.model).toBe("");
		expect(helpers.DEFAULT_LLM.dictation.presets).toEqual([
			{ key: "neutral" },
			{ key: "reorder" },
			{ key: "restructure" },
			{ key: "rewordForClarity" },
		]);
		expect(helpers.DEFAULT_LLM.transforms.enabled).toBe(false);
		expect(helpers.DEFAULT_LLM.transforms.provider).toBe("ollama");
		expect(helpers.DEFAULT_LLM.transforms.model).toBe("");
	});

	test("DEFAULT_FEATURE is the shared per-feature baseline (no presets)", () => {
		expect(helpers.DEFAULT_FEATURE).toEqual({
			dictionaryAutoAddEnabled: false,
			enabled: false,
			provider: "ollama",
			model: "",
			openrouterModel: "",
			openrouterFallbackModel: "",
			reasoningEffort: "medium",
			thinkingEffort: "off",
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
		const snap = helpers.readFeatureSnapshot({
			provider: "openrouter",
			enabled: true,
		});
		expect(snap.provider).toBe("openrouter");
		expect(snap.enabled).toBe(true);
		expect(snap.model).toBe("");
		expect(snap.openrouterModel).toBe("");
	});
});

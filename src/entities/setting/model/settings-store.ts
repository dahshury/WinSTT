import { create } from "zustand";
import { persist } from "zustand/middleware";
import { commands } from "@/bindings";
import {
	type AppSettingsOutput,
	appSettingsSchema,
} from "@/shared/config/settings-schema";

const DEFAULTS: AppSettingsOutput = appSettingsSchema.parse({});

function isRealSettingsWindow(): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	const internals = (
		window as Window & {
			__TAURI_INTERNALS__?: {
				metadata?: { currentWindow?: { label?: string } };
			};
		}
	).__TAURI_INTERNALS__;
	return internals?.metadata?.currentWindow?.label === "settings";
}

type Integrations = AppSettingsOutput["integrations"];
type GeneralSettings = AppSettingsOutput["general"];
type LlmSettings = AppSettingsOutput["llm"];
type LlmDictationSettings = LlmSettings["dictation"];

type LlmPostProcessingPatch = Partial<
	Pick<
		LlmDictationSettings,
		| "customModifiers"
		| "enabled"
		| "maxOutputTokens"
		| "model"
		| "openrouterFallbackModel"
		| "openrouterModel"
		| "presets"
		| "provider"
		| "reasoningEffort"
		| "thinkingEffort"
		| "verbosity"
	>
> &
	Partial<Pick<LlmDictationSettings, "dictionaryAutoAddEnabled">>;
interface IntegrationPatch {
	elevenlabs?: Partial<Integrations["elevenlabs"]>;
}

type ModelSection = AppSettingsOutput["model"];

/**
 * Patch shape for ``updateModelSettings``.
 *
 * A plain partial of the model section: any subset of fields may be written,
 * including ``model`` on its own. The engine is routed from the model id at
 * load time (Rust ``SttBackend::route_of``), so there is no paired label that
 * must travel with the model — the old ``{ model, backend }`` couple invariant
 * (and its discriminated union) is gone with the ``backend`` field.
 */
export type ModelPatch = Partial<ModelSection>;

/**
 * Shallow-merge each provider patch into the current integrations record.
 * Pulled out of the store callback so the closure stays CC ≤ 1 (the
 * per-provider conditional spread inflated the closure's complexity
 * past the CRAP threshold).
 *
 * Spreading `undefined` is a no-op in ES, so we don't need a guard.
 */
function mergeIntegrations(
	settings: AppSettingsOutput,
	patch: IntegrationPatch,
): Integrations {
	const current = settings.integrations;
	return {
		...current,
		elevenlabs: { ...current.elevenlabs, ...patch.elevenlabs },
	};
}

function normalizeGeneralSettings(
	settings: AppSettingsOutput,
): GeneralSettings {
	const general = { ...settings.general };
	if (general.wordByWordPasting) {
		general.previewBeforePasting = false;
	}
	return general;
}

function normalizeLlmSettings(settings: AppSettingsOutput): LlmSettings {
	if (!settings.general.wordByWordPasting) {
		return settings.llm;
	}
	return {
		...settings.llm,
		dictation: { ...settings.llm.dictation, enabled: false },
		transforms: { ...settings.llm.transforms, enabled: false },
	};
}

function normalizeSettings(settings: AppSettingsOutput): AppSettingsOutput {
	const next = {
		...settings,
		general: normalizeGeneralSettings(settings),
	};
	return {
		...next,
		llm: normalizeLlmSettings(next),
	};
}

/**
 * Strip secret fields before they hit localStorage.
 *
 * The backend store is the source of truth for API keys — it seals them at
 * rest and re-hydrates them through the decrypt path on load. Persisting the
 * plaintext keys here (``integrations.elevenlabs.apiKey``,
 * ``llm.openrouterApiKey``) would defeat that sealing by leaving a cleartext
 * copy in localStorage. Blank them on the way out; the schema requires the
 * fields to exist (so we keep ``""`` rather than deleting them), and the backend
 * overwrites them on the next sync.
 */
function stripSecrets(settings: AppSettingsOutput): AppSettingsOutput {
	return {
		...settings,
		llm: { ...settings.llm, openrouterApiKey: "" },
		integrations: {
			...settings.integrations,
			elevenlabs: { ...settings.integrations.elevenlabs, apiKey: "" },
		},
	};
}

/**
 * Top-level settings keys whose value is an object section.
 */
type ObjectSectionKey = {
	[K in keyof AppSettingsOutput]: AppSettingsOutput[K] extends object
		? K
		: never;
}[keyof AppSettingsOutput];

/**
 * Shallow-merge `patch` into a single top-level section of the settings tree,
 * returning the next `settings` slice. Collapses the otherwise-identical
 * `update<Section>Settings` callbacks (quality/audio/global/hotkey/llm/tts) to
 * one-liners. Sections that need extra work — `general`/`llm.dictation`
 * (normalize), `model` (union-erase), `dictionary`/`snippets` (wholesale
 * replace) — keep their bespoke callbacks.
 */
function patchSection<K extends ObjectSectionKey>(
	settings: AppSettingsOutput,
	key: K,
	patch: Partial<AppSettingsOutput[K]>,
): AppSettingsOutput {
	return {
		...settings,
		[key]: { ...settings[key], ...patch },
	};
}

interface SettingsState {
	isLoaded: boolean;
	resetSettings: () => void;
	setLoaded: (loaded: boolean) => void;
	setSettings: (settings: AppSettingsOutput) => void;
	settings: AppSettingsOutput;
	updateAudioSettings: (patch: Partial<AppSettingsOutput["audio"]>) => void;
	updateDictionary: (dictionary: AppSettingsOutput["dictionary"]) => void;
	updateGlobalSettings: (patch: Partial<AppSettingsOutput["global"]>) => void;
	updateGeneralSettings: (patch: Partial<AppSettingsOutput["general"]>) => void;
	updateHotkeySettings: (patch: Partial<AppSettingsOutput["hotkey"]>) => void;
	/**
	 * Patches the per-provider integration record on `settings.integrations`.
	 * Each provider patch is shallow-merged so the caller can update just
	 * `apiKey` (typing) or just `verified` + `lastVerifiedAt` (probe result)
	 * without clobbering the other field.
	 */
	updateIntegrations: (patch: {
		elevenlabs?: Partial<AppSettingsOutput["integrations"]["elevenlabs"]>;
	}) => void;
	updateLlmDictation: (
		patch: Partial<AppSettingsOutput["llm"]["dictation"]>,
	) => void;
	updateLlmPostProcessing: (patch: LlmPostProcessingPatch) => void;
	updateLlmAppProfiles: (
		rules: AppSettingsOutput["llm"]["appProfiles"]["rules"],
	) => void;
	/**
	 * Patches top-level shared fields on `settings.llm` (endpoint, openrouterApiKey).
	 * For per-feature config use `updateLlmDictation` / `updateLlmTransforms`.
	 */
	updateLlmSettings: (
		patch: Partial<Omit<AppSettingsOutput["llm"], "dictation" | "transforms">>,
	) => void;
	/** Patches the read-aloud post-processing config (`llm.readAloud`) — its
	 *  enable flag plus the provider/model/tone/modifiers its assigned
	 *  configuration resolved to. */
	updateLlmReadAloud: (
		patch: Partial<AppSettingsOutput["llm"]["readAloud"]>,
	) => void;
	/**
	 * Adopt `model` as THE shared local model.
	 *
	 * While `allowMultipleLocalModels` is off, every locally-running consumer has
	 * to resolve onto ONE model: Ollama does not refuse to overcommit, it evicts
	 * an idle model to make room, so a second resident local model turns every
	 * switch between features into a silent multi-second reload.
	 *
	 * It lives here, as one atomic write across `llm.localModel` and the three
	 * consumers, because the invariant spans slices and every surface that lands
	 * a local model has to uphold it — the model picker used to write only
	 * `localModel` plus the feature it was opened from, leaving the other
	 * consumers pointing at the previous model and two models resident.
	 */
	updateLlmSharedLocalModel: (model: string) => void;
	updateLlmTransforms: (
		patch: Partial<AppSettingsOutput["llm"]["transforms"]>,
	) => void;
	updateModelSettings: (patch: ModelPatch) => void;
	updateQualitySettings: (patch: Partial<AppSettingsOutput["quality"]>) => void;
	updateSnippets: (snippets: AppSettingsOutput["snippets"]) => void;
	updateTtsSettings: (patch: Partial<AppSettingsOutput["tts"]>) => void;
}

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set) => ({
			settings: DEFAULTS,
			// Stryker disable next-line BooleanLiteral: equivalent — onFinishHydration
			// (or the synchronous hasHydrated branch) overwrites isLoaded to true
			// at module init, so the initial value is never observable in tests.
			isLoaded: false,
			// Audit #23: `setSettings` is the HYDRATION / cross-window BROADCAST
			// path, not a user edit. It must NOT re-run the wordByWordPasting
			// coupling — doing so silently cleared the user's `llm.*.enabled` flags
			// whenever an unrelated broadcast (e.g. a VAD calibration save from
			// another window) landed while wordByWordPasting happened to be on, and
			// the next save then persisted the cleared flags (permanent loss). The
			// coupling is enforced only on the RELEVANT transition — the user turning
			// wordByWordPasting on via `updateGeneralSettings`. The writer normalises
			// before persisting, so the value handed here is already consistent.
			setSettings: (settings) => set({ settings, isLoaded: true }),
			updateModelSettings: (patch) =>
				set((state) => ({
					settings: {
						...state.settings,
						model: { ...state.settings.model, ...patch },
					},
				})),
			updateQualitySettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "quality", patch),
				})),
			updateAudioSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "audio", patch),
				})),
			updateGeneralSettings: (patch) =>
				set((state) => {
					const settings = {
						...state.settings,
						general: { ...state.settings.general, ...patch },
					};
					return { settings: normalizeSettings(settings) };
				}),
			updateGlobalSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "global", patch),
				})),
			updateHotkeySettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "hotkey", patch),
				})),
			updateLlmSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "llm", patch),
				})),
			updateLlmAppProfiles: (rules) =>
				set((state) => ({
					settings: {
						...state.settings,
						llm: {
							...state.settings.llm,
							appProfiles: { ...state.settings.llm.appProfiles, rules },
						},
					},
				})),
			updateLlmDictation: (patch) =>
				set((state) => {
					const settings = {
						...state.settings,
						llm: {
							...state.settings.llm,
							dictation: { ...state.settings.llm.dictation, ...patch },
						},
					};
					return { settings: normalizeSettings(settings) };
				}),
			// Transformations used to be a SHADOW of dictation: this action copied
			// dictation's provider, model, tuning, tone, modifiers AND `enabled`
			// straight into `llm.transforms`, so the two could never be configured
			// apart. They are independent consumers now — each is ASSIGNED a saved
			// configuration — so this writes dictation only.
			updateLlmPostProcessing: (patch) =>
				set((state) => {
					const settings = {
						...state.settings,
						llm: {
							...state.settings.llm,
							dictation: { ...state.settings.llm.dictation, ...patch },
						},
					};
					return { settings: normalizeSettings(settings) };
				}),
			updateLlmReadAloud: (patch) =>
				set((state) => ({
					settings: {
						...state.settings,
						llm: {
							...state.settings.llm,
							readAloud: { ...state.settings.llm.readAloud, ...patch },
						},
					},
				})),
			updateLlmTransforms: (patch) =>
				set((state) => ({
					settings: {
						...state.settings,
						llm: {
							...state.settings.llm,
							transforms: { ...state.settings.llm.transforms, ...patch },
						},
					},
				})),
			updateLlmSharedLocalModel: (model) =>
				set((state) => {
					const llm = state.settings.llm;
					// Cloud consumers are unconstrained (their model costs no VRAM), and
					// the power toggle frees every consumer to keep its own. Unchanged
					// slices are returned by identity so subscribers don't re-render.
					const adopt = <T extends { model: string; provider: string }>(
						feature: T,
					): T =>
						llm.allowMultipleLocalModels ||
						feature.provider !== "ollama" ||
						feature.model === model
							? feature
							: { ...feature, model };
					return {
						settings: {
							...state.settings,
							llm: {
								...llm,
								localModel: model,
								dictation: adopt(llm.dictation),
								readAloud: adopt(llm.readAloud),
								transforms: adopt(llm.transforms),
							},
						},
					};
				}),
			updateDictionary: (dictionary) =>
				set((state) => ({
					settings: { ...state.settings, dictionary },
				})),
			updateSnippets: (snippets) =>
				set((state) => ({
					settings: { ...state.settings, snippets },
				})),
			updateTtsSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "tts", patch),
				})),
			updateIntegrations: (patch) =>
				set((state) => ({
					settings: {
						...state.settings,
						integrations: mergeIntegrations(state.settings, patch),
					},
				})),
			resetSettings: () => {
				// A full reset is an explicit, trusted action. In the real Settings
				// webview let the backend replace the whole canonical tree so its
				// anti-wipe guard cannot mistake the defaults for an unhydrated cache
				// dump. Plain Vite/tests have no native command and reset locally; the
				// normal dev settings bridge persists that local diff.
				if (isRealSettingsWindow()) {
					void commands
						.settingsResetDefaults()
						.then((result) => {
							if (result.status === "error") {
								throw new Error(result.error);
							}
							set({
								settings: appSettingsSchema.parse(result.data.settings),
								isLoaded: true,
							});
						})
						.catch((error: unknown) => {
							console.error("[settings] reset to defaults failed:", error);
						});
					return;
				}
				set({ settings: DEFAULTS });
			},
			setLoaded: (loaded) => set({ isLoaded: loaded }),
		}),
		{
			name: "winstt-settings",
			// Never write API keys to localStorage in plaintext — the backend
			// store seals them at rest and re-hydrates them on load. See
			// ``stripSecrets``.
			partialize: (state) => ({ settings: stripSecrets(state.settings) }),
		},
	),
);

export function getSettingsStoreState(): SettingsState {
	return useSettingsStore.getState();
}

// Mark loaded after localStorage hydration completes.
// Cannot use onRehydrateStorage because it fires during create() before
// useSettingsStore is assigned, causing a ReferenceError.
// Use onFinishHydration + hasHydrated check to cover both sync and async
// hydration. The block below is module-init code that runs once when the
// store module is imported; under bun:test the renderer runs in a jsdom-like
// env where hydration completes synchronously, so most mutants on these
// guards/setters are unobservable in the test suite.
// Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral,BlockStatement
if (typeof window !== "undefined") {
	// Stryker disable next-line ConditionalExpression,BlockStatement
	if (useSettingsStore.persist.hasHydrated()) {
		// Stryker disable next-line ObjectLiteral,BooleanLiteral
		useSettingsStore.setState({ isLoaded: true });
	}
	useSettingsStore.persist.onFinishHydration(() => {
		// Stryker disable next-line ObjectLiteral,BooleanLiteral
		useSettingsStore.setState({ isLoaded: true });
	});
}

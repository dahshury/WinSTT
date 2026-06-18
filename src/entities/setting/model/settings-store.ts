import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TranscriberBackend } from "@/shared/api/schema.zod";
import {
	type AppSettingsOutput,
	appSettingsSchema,
} from "@/shared/config/settings-schema";

const DEFAULTS: AppSettingsOutput = appSettingsSchema.parse({});

type Integrations = AppSettingsOutput["integrations"];
type GeneralSettings = AppSettingsOutput["general"];
type LlmSettings = AppSettingsOutput["llm"];
interface IntegrationPatch {
	elevenlabs?: Partial<Integrations["elevenlabs"]>;
}

type ModelSection = AppSettingsOutput["model"];
type ModelPatchSansCouple = Partial<Omit<ModelSection, "model" | "backend">>;

/**
 * Patch shape for ``updateModelSettings``.
 *
 * Encodes the runtime invariant that the main ``model`` and its
 * ``backend`` must always be written together. Every catalog entry pins
 * exactly one backend per model id, so writing ``model`` alone leaves
 * ``backend`` pointing at the previous model's engine — the exact drift
 * that produced ``model = nemo-canary-180m-flash, backend = faster_whisper``
 * on disk and forced the in-flight ``adoptRuntime`` workaround.
 *
 * The discriminated union below makes that invariant a compile error:
 *
 *   - Patches without ``model`` may freely set every other field.
 *   - Patches with ``model``: ``backend`` is required.
 *
 * Authoring tip: when changing the main model, look up the catalog entry
 * (``useCatalogStore.getState().models.find(...)``) and patch both fields
 * together. ``setMainModelById`` below does this in one step.
 */
export type ModelPatch =
	| (ModelPatchSansCouple & { backend?: TranscriberBackend; model?: undefined })
	| (ModelPatchSansCouple & { backend: TranscriberBackend; model: string });

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
	/**
	 * Patches top-level shared fields on `settings.llm` (endpoint, openrouterApiKey).
	 * For per-feature config use `updateLlmDictation` / `updateLlmTransforms`.
	 */
	updateLlmSettings: (
		patch: Partial<Omit<AppSettingsOutput["llm"], "dictation" | "transforms">>,
	) => void;
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
			setSettings: (settings) =>
				set({ settings: normalizeSettings(settings), isLoaded: true }),
			updateModelSettings: (patch) => {
				// Discriminated-union narrowing breaks Zustand's set() inference
				// (the spread of a union-typed object produces an unsatisfiable
				// shape). Erase to a plain partial here — the type guard at the
				// public ``updateModelSettings`` signature is what enforces the
				// model/backend coupling.
				const patchAsPartial = patch as Partial<ModelSection>;
				set((state) => ({
					settings: {
						...state.settings,
						model: { ...state.settings.model, ...patchAsPartial },
					},
				}));
			},
			updateQualitySettings: (patch) =>
				set((state) => ({
					settings: {
						...state.settings,
						quality: { ...state.settings.quality, ...patch },
					},
				})),
			updateAudioSettings: (patch) =>
				set((state) => ({
					settings: {
						...state.settings,
						audio: { ...state.settings.audio, ...patch },
					},
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
					settings: {
						...state.settings,
						global: { ...state.settings.global, ...patch },
					},
				})),
			updateHotkeySettings: (patch) =>
				set((state) => ({
					settings: {
						...state.settings,
						hotkey: { ...state.settings.hotkey, ...patch },
					},
				})),
			updateLlmSettings: (patch) =>
				set((state) => ({
					settings: {
						...state.settings,
						llm: { ...state.settings.llm, ...patch },
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
					settings: {
						...state.settings,
						tts: { ...state.settings.tts, ...patch },
					},
				})),
			updateIntegrations: (patch) =>
				set((state) => ({
					settings: {
						...state.settings,
						integrations: mergeIntegrations(state.settings, patch),
					},
				})),
			resetSettings: () =>
				set((state) => ({
					settings: {
						...DEFAULTS,
						dictionary: state.settings.dictionary,
						snippets: state.settings.snippets,
					},
				})),
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

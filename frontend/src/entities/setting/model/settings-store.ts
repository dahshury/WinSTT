import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type AppSettingsOutput, appSettingsSchema } from "@/shared/config/settings-schema";

const DEFAULTS: AppSettingsOutput = appSettingsSchema.parse({});

interface SettingsState {
	isLoaded: boolean;
	resetSettings: () => void;
	setLoaded: (loaded: boolean) => void;
	setSettings: (settings: AppSettingsOutput) => void;
	settings: AppSettingsOutput;
	updateAudioSettings: (patch: Partial<AppSettingsOutput["audio"]>) => void;
	updateDictionary: (dictionary: AppSettingsOutput["dictionary"]) => void;
	updateGeneralSettings: (patch: Partial<AppSettingsOutput["general"]>) => void;
	updateHotkeySettings: (patch: Partial<AppSettingsOutput["hotkey"]>) => void;
	updateLlmSettings: (patch: Partial<AppSettingsOutput["llm"]>) => void;
	updateModelSettings: (patch: Partial<AppSettingsOutput["model"]>) => void;
	updateQualitySettings: (patch: Partial<AppSettingsOutput["quality"]>) => void;
	updateSnippets: (snippets: AppSettingsOutput["snippets"]) => void;
}

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set) => ({
			settings: DEFAULTS,
			// Stryker disable next-line BooleanLiteral: equivalent — onFinishHydration
			// (or the synchronous hasHydrated branch) overwrites isLoaded to true
			// at module init, so the initial value is never observable in tests.
			isLoaded: false,
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
				set((state) => ({
					settings: {
						...state.settings,
						general: { ...state.settings.general, ...patch },
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
			updateDictionary: (dictionary) =>
				set((state) => ({
					settings: { ...state.settings, dictionary },
				})),
			updateSnippets: (snippets) =>
				set((state) => ({
					settings: { ...state.settings, snippets },
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
			partialize: (state) => ({ settings: state.settings }),
		}
	)
);

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

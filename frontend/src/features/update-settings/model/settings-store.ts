import type { components } from "@spec/schema";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { appSettingsSchema } from "@/shared/config/settings-schema";

type AppSettings = components["schemas"]["AppSettings"];

const DEFAULTS = appSettingsSchema.parse({}) as AppSettings;

interface SettingsState {
	settings: AppSettings;
	isLoaded: boolean;
	setSettings: (settings: AppSettings) => void;
	updateModelSettings: (patch: Partial<NonNullable<AppSettings["model"]>>) => void;
	updateQualitySettings: (patch: Partial<NonNullable<AppSettings["quality"]>>) => void;
	updateAudioSettings: (patch: Partial<NonNullable<AppSettings["audio"]>>) => void;
	updateGeneralSettings: (patch: Partial<NonNullable<AppSettings["general"]>>) => void;
	updateHotkeySettings: (patch: Partial<NonNullable<AppSettings["hotkey"]>>) => void;
	resetSettings: () => void;
	setLoaded: (loaded: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set) => ({
			settings: DEFAULTS,
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
			resetSettings: () =>
				set((state) => ({
					settings: {
						...DEFAULTS,
						dictionary: state.settings.dictionary,
						snippets: state.settings.snippets,
					} as AppSettings,
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
// Use onFinishHydration + hasHydrated check to cover both sync and async hydration.
if (typeof window !== "undefined") {
	if (useSettingsStore.persist.hasHydrated()) {
		useSettingsStore.setState({ isLoaded: true });
	}
	useSettingsStore.persist.onFinishHydration(() => {
		useSettingsStore.setState({ isLoaded: true });
	});
}

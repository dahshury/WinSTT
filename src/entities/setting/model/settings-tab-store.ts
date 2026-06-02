import { create } from "zustand";

/**
 * Active tab key for the settings window's vertical sidebar.
 * Lifted out of `SettingsPage` so non-sibling components (e.g. the Cloud
 * source badge in `ModelSettingsPanel`) can navigate the sidebar.
 *
 * Keys match the `Tabs.Panel value` strings in `SettingsPage`. Kept as a
 * free-form string instead of a union so adding a tab in the page doesn't
 * require widening this type in two places.
 */
interface SettingsTabState {
	activeTab: string;
	setActiveTab: (tab: string) => void;
}

export const useSettingsTabStore = create<SettingsTabState>((set) => ({
	activeTab: "recording",
	setActiveTab: (tab) => set({ activeTab: tab }),
}));

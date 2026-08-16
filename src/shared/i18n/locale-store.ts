import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_LOCALE, type Locale } from "./config";

export const LOCALE_STORAGE_KEY = "winstt-locale";

interface LocaleState {
	locale: Locale;
	setLocale: (locale: Locale) => void;
}

export const useLocaleStore = create<LocaleState>()(
	persist(
		(set) => ({
			locale: DEFAULT_LOCALE,
			setLocale: (locale) => set({ locale }),
		}),
		{ name: LOCALE_STORAGE_KEY },
	),
);

// Zustand persist hydrates only when this JavaScript context starts. Language
// changes made in another WinSTT window arrive through the browser `storage`
// event, so explicitly rehydrate that window's store from the shared key.
// Rehydrating (instead of calling setState) avoids writing the same value back
// and creating a cross-window storage-event loop.
if (typeof window !== "undefined") {
	window.addEventListener("storage", (event) => {
		if (event.key === LOCALE_STORAGE_KEY) {
			void useLocaleStore.persist.rehydrate();
		}
	});
}

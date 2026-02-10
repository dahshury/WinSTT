export const LOCALES = ["en", "zh", "es", "hi", "fr", "ar"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_NAMES: Record<Locale, { name: string; native: string }> = {
	en: { name: "English", native: "English" },
	zh: { name: "Chinese", native: "中文" },
	es: { name: "Spanish", native: "Español" },
	hi: { name: "Hindi", native: "हिन्दी" },
	fr: { name: "French", native: "Français" },
	ar: { name: "Arabic", native: "العربية" },
};

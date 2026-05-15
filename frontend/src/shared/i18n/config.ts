export const LOCALES = ["en", "zh", "es", "hi", "fr", "ar"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

const LOCALE_SEPARATOR_RE = /[-_]/;

export function isLocale(value: string): value is Locale {
	return (LOCALES as readonly string[]).includes(value);
}

/** Map a BCP-47 / OS locale tag (e.g. "en-US", "zh_CN") to a supported {@link Locale}. */
export function pickLocaleFromSystem(input: string | null | undefined): Locale {
	if (!input) {
		return DEFAULT_LOCALE;
	}
	const primary = input.toLowerCase().split(LOCALE_SEPARATOR_RE)[0];
	return primary && isLocale(primary) ? primary : DEFAULT_LOCALE;
}

export const LOCALE_NAMES: Record<Locale, { name: string; native: string }> = {
	en: { name: "English", native: "English" },
	zh: { name: "Chinese", native: "中文" },
	es: { name: "Spanish", native: "Español" },
	hi: { name: "Hindi", native: "हिन्दी" },
	fr: { name: "French", native: "Français" },
	ar: { name: "Arabic", native: "العربية" },
};

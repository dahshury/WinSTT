// Supported renderer locales. Each entry needs:
//   * a `messages/<code>.json` baseline (key parity with `en.json` is enforced
//     by `bun check:i18n`; the `--strict` variant additionally fails on
//     English-equal values so untranslated baselines surface at review time).
//   * a `LOCALE_NAMES` entry below for the language-picker label.
//   * a `Locale`-typed match in `pickLocaleFromSystem` for OS-locale matching.
//
// Newly seeded baselines (de, ja, ko, pt, ru, it, pl, tr, sv, cs, bg, he, uk,
// vi) are copies of `en.json` and need community translation passes — they
// satisfy the parity gate but display English until refined.
export const LOCALES = [
	"en",
	"ar",
	"bg",
	"cs",
	"de",
	"es",
	"fr",
	"he",
	"hi",
	"it",
	"ja",
	"ko",
	"pl",
	"pt",
	"ru",
	"sv",
	"tr",
	"uk",
	"vi",
	"zh",
] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

// RTL languages need a `dir="rtl"` attribute on the root element. Pulled
// in by IntlProvider so newly seeded RTL baselines (he) render correctly
// without a separate code change.
export const RTL_LOCALES: ReadonlySet<Locale> = new Set(["ar", "he"]);

const LOCALE_SEPARATOR_RE = /[-_]/;

export function isLocale(value: string): value is Locale {
	return (LOCALES as readonly string[]).includes(value);
}

function primaryLocaleTag(input: string): string {
	const [head = ""] = input.toLowerCase().split(LOCALE_SEPARATOR_RE);
	return head;
}

/** Map a BCP-47 / OS locale tag (e.g. "en-US", "zh_CN") to a supported {@link Locale}. */
export function pickLocaleFromSystem(input: string | null | undefined): Locale {
	if (!input) {
		return DEFAULT_LOCALE;
	}
	const primary = primaryLocaleTag(input);
	return isLocale(primary) ? primary : DEFAULT_LOCALE;
}

export const LOCALE_NAMES: Record<Locale, { name: string; native: string }> = {
	en: { name: "English", native: "English" },
	ar: { name: "Arabic", native: "العربية" },
	bg: { name: "Bulgarian", native: "Български" },
	cs: { name: "Czech", native: "Čeština" },
	de: { name: "German", native: "Deutsch" },
	es: { name: "Spanish", native: "Español" },
	fr: { name: "French", native: "Français" },
	he: { name: "Hebrew", native: "עברית" },
	hi: { name: "Hindi", native: "हिन्दी" },
	it: { name: "Italian", native: "Italiano" },
	ja: { name: "Japanese", native: "日本語" },
	ko: { name: "Korean", native: "한국어" },
	pl: { name: "Polish", native: "Polski" },
	pt: { name: "Portuguese", native: "Português" },
	ru: { name: "Russian", native: "Русский" },
	sv: { name: "Swedish", native: "Svenska" },
	tr: { name: "Turkish", native: "Türkçe" },
	uk: { name: "Ukrainian", native: "Українська" },
	vi: { name: "Vietnamese", native: "Tiếng Việt" },
	zh: { name: "Chinese", native: "中文" },
};

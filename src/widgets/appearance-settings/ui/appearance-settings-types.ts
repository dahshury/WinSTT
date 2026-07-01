import type { GeneralT } from "@/entities/setting";
import { type Locale, LOCALE_NAMES, LOCALES } from "@/shared/i18n";
import type { SelectOption } from "@/shared/ui/select";

export type { GeneralSettings, GeneralT } from "@/entities/setting";
// ``UpdateFn`` is this widget's local name for the shared general update-fn.
export type { UpdateGeneralFn as UpdateFn } from "@/entities/setting";

// Country-code chip shown in the language picker — the ISO 3166-1 alpha-2
// country most associated with each locale (English → US per the product
// spec; the rest use the language's canonical/origin country). Text only, no
// flag image. Keep entries in sync with LOCALES in shared/i18n/config.ts when
// adding a new locale baseline.
const LOCALE_BADGE: Record<Locale, string> = {
	en: "US",
	ar: "SA",
	bg: "BG",
	cs: "CZ",
	de: "DE",
	es: "ES",
	fr: "FR",
	he: "IL",
	hi: "IN",
	it: "IT",
	ja: "JP",
	ko: "KR",
	pl: "PL",
	pt: "PT",
	ru: "RU",
	sv: "SE",
	tr: "TR",
	uk: "UA",
	vi: "VN",
	zh: "CN",
};

export const LANGUAGE_OPTIONS: SelectOption[] = LOCALES.map((code) => ({
	id: code,
	label: LOCALE_NAMES[code].native,
	badge: LOCALE_BADGE[code],
}));

export type GeneralMessageKey = Parameters<GeneralT>[0];

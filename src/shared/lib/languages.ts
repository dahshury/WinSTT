// Target-language catalog for the built-in `translate` dictation modifier.
//
// The persisted/selected value is the *English name* (e.g. "Spanish"), not the
// ISO code: it is stable, human-readable in the settings JSON, and can be
// dropped straight into the LLM translate instruction without a code→name
// lookup at compose time. `code` is display-only (the combobox badge);
// `nativeName` is the secondary label so speakers recognize their language.
//
// Scope is the canonical Whisper / common-LLM language set (~the languages a
// modern instruction-tuned model translates reliably). The picker is a
// searchable combobox, so a long list stays usable.

export interface Language {
	/** ISO 639-1 (or BCP-47 short) code — shown as the combobox badge only. */
	code: string;
	/** Canonical English name. This IS the persisted `targetLang` value. */
	englishName: string;
	/** Endonym, shown as the secondary label. */
	nativeName: string;
}

export const LANGUAGES: readonly Language[] = [
	{ code: "en", englishName: "English", nativeName: "English" },
	{ code: "es", englishName: "Spanish", nativeName: "Español" },
	{ code: "fr", englishName: "French", nativeName: "Français" },
	{ code: "de", englishName: "German", nativeName: "Deutsch" },
	{ code: "it", englishName: "Italian", nativeName: "Italiano" },
	{ code: "pt", englishName: "Portuguese", nativeName: "Português" },
	{ code: "nl", englishName: "Dutch", nativeName: "Nederlands" },
	{ code: "ru", englishName: "Russian", nativeName: "Русский" },
	{ code: "pl", englishName: "Polish", nativeName: "Polski" },
	{ code: "uk", englishName: "Ukrainian", nativeName: "Українська" },
	{ code: "cs", englishName: "Czech", nativeName: "Čeština" },
	{ code: "sk", englishName: "Slovak", nativeName: "Slovenčina" },
	{ code: "ro", englishName: "Romanian", nativeName: "Română" },
	{ code: "hu", englishName: "Hungarian", nativeName: "Magyar" },
	{ code: "el", englishName: "Greek", nativeName: "Ελληνικά" },
	{ code: "bg", englishName: "Bulgarian", nativeName: "Български" },
	{ code: "sr", englishName: "Serbian", nativeName: "Српски" },
	{ code: "hr", englishName: "Croatian", nativeName: "Hrvatski" },
	{ code: "sl", englishName: "Slovenian", nativeName: "Slovenščina" },
	{ code: "lt", englishName: "Lithuanian", nativeName: "Lietuvių" },
	{ code: "lv", englishName: "Latvian", nativeName: "Latviešu" },
	{ code: "et", englishName: "Estonian", nativeName: "Eesti" },
	{ code: "fi", englishName: "Finnish", nativeName: "Suomi" },
	{ code: "sv", englishName: "Swedish", nativeName: "Svenska" },
	{ code: "da", englishName: "Danish", nativeName: "Dansk" },
	{ code: "nb", englishName: "Norwegian", nativeName: "Norsk" },
	{ code: "is", englishName: "Icelandic", nativeName: "Íslenska" },
	{ code: "ga", englishName: "Irish", nativeName: "Gaeilge" },
	{ code: "cy", englishName: "Welsh", nativeName: "Cymraeg" },
	{ code: "ca", englishName: "Catalan", nativeName: "Català" },
	{ code: "gl", englishName: "Galician", nativeName: "Galego" },
	{ code: "eu", englishName: "Basque", nativeName: "Euskara" },
	{ code: "ar", englishName: "Arabic", nativeName: "العربية" },
	{ code: "he", englishName: "Hebrew", nativeName: "עברית" },
	{ code: "fa", englishName: "Persian", nativeName: "فارسی" },
	{ code: "ur", englishName: "Urdu", nativeName: "اردو" },
	{ code: "tr", englishName: "Turkish", nativeName: "Türkçe" },
	{ code: "az", englishName: "Azerbaijani", nativeName: "Azərbaycanca" },
	{ code: "kk", englishName: "Kazakh", nativeName: "Қазақша" },
	{ code: "uz", englishName: "Uzbek", nativeName: "Oʻzbekcha" },
	{ code: "hy", englishName: "Armenian", nativeName: "Հայերեն" },
	{ code: "ka", englishName: "Georgian", nativeName: "ქართული" },
	{ code: "hi", englishName: "Hindi", nativeName: "हिन्दी" },
	{ code: "bn", englishName: "Bengali", nativeName: "বাংলা" },
	{ code: "pa", englishName: "Punjabi", nativeName: "ਪੰਜਾਬੀ" },
	{ code: "gu", englishName: "Gujarati", nativeName: "ગુજરાતી" },
	{ code: "mr", englishName: "Marathi", nativeName: "मराठी" },
	{ code: "ta", englishName: "Tamil", nativeName: "தமிழ்" },
	{ code: "te", englishName: "Telugu", nativeName: "తెలుగు" },
	{ code: "kn", englishName: "Kannada", nativeName: "ಕನ್ನಡ" },
	{ code: "ml", englishName: "Malayalam", nativeName: "മലയാളം" },
	{ code: "si", englishName: "Sinhala", nativeName: "සිංහල" },
	{ code: "ne", englishName: "Nepali", nativeName: "नेपाली" },
	{ code: "zh", englishName: "Chinese (Simplified)", nativeName: "简体中文" },
	{
		code: "zh-Hant",
		englishName: "Chinese (Traditional)",
		nativeName: "繁體中文",
	},
	{ code: "yue", englishName: "Cantonese", nativeName: "粵語" },
	{ code: "ja", englishName: "Japanese", nativeName: "日本語" },
	{ code: "ko", englishName: "Korean", nativeName: "한국어" },
	{ code: "vi", englishName: "Vietnamese", nativeName: "Tiếng Việt" },
	{ code: "th", englishName: "Thai", nativeName: "ไทย" },
	{ code: "lo", englishName: "Lao", nativeName: "ລາວ" },
	{ code: "km", englishName: "Khmer", nativeName: "ខ្មែរ" },
	{ code: "my", englishName: "Burmese", nativeName: "မြန်မာ" },
	{ code: "id", englishName: "Indonesian", nativeName: "Bahasa Indonesia" },
	{ code: "ms", englishName: "Malay", nativeName: "Bahasa Melayu" },
	{ code: "tl", englishName: "Filipino", nativeName: "Filipino" },
	{ code: "sw", englishName: "Swahili", nativeName: "Kiswahili" },
	{ code: "am", englishName: "Amharic", nativeName: "አማርኛ" },
	{ code: "ha", englishName: "Hausa", nativeName: "Hausa" },
	{ code: "yo", englishName: "Yoruba", nativeName: "Yorùbá" },
	{ code: "ig", englishName: "Igbo", nativeName: "Igbo" },
	{ code: "zu", englishName: "Zulu", nativeName: "isiZulu" },
	{ code: "xh", englishName: "Xhosa", nativeName: "isiXhosa" },
	{ code: "af", englishName: "Afrikaans", nativeName: "Afrikaans" },
	{ code: "so", englishName: "Somali", nativeName: "Soomaali" },
	{ code: "mt", englishName: "Maltese", nativeName: "Malti" },
	{ code: "sq", englishName: "Albanian", nativeName: "Shqip" },
	{ code: "mk", englishName: "Macedonian", nativeName: "Македонски" },
	{ code: "bs", englishName: "Bosnian", nativeName: "Bosanski" },
	{ code: "be", englishName: "Belarusian", nativeName: "Беларуская" },
	{ code: "mn", englishName: "Mongolian", nativeName: "Монгол" },
	{ code: "tg", englishName: "Tajik", nativeName: "Тоҷикӣ" },
	{ code: "ky", englishName: "Kyrgyz", nativeName: "Кыргызча" },
	{ code: "tk", englishName: "Turkmen", nativeName: "Türkmençe" },
	{ code: "ps", englishName: "Pashto", nativeName: "پښتو" },
	{ code: "ku", englishName: "Kurdish", nativeName: "Kurdî" },
	{ code: "la", englishName: "Latin", nativeName: "Latina" },
] as const;

/** Selected when the `translate` modifier is enabled without an explicit
 *  choice. English is the safe, universally-supported default. */
export const DEFAULT_TARGET_LANG = "English";

const LANGUAGE_BY_NAME = new Map<string, Language>(
	LANGUAGES.map((l) => [l.englishName, l]),
);

/** Resolve a persisted `targetLang` to its catalog entry, tolerating an
 *  unknown/legacy value by returning `undefined` (callers fall back to the
 *  raw string so a future-added language still translates correctly). */
export function findLanguage(
	englishName: string | undefined,
): Language | undefined {
	return englishName ? LANGUAGE_BY_NAME.get(englishName) : undefined;
}

// Sample sentence read aloud by the "Test voice" button. Static so the speed/
// voice change is the only audible variable.
const TEST_SAMPLE_FALLBACK = "The quick brown fox jumps over the lazy dog.";

// Per-language demo line so previewing a non-English voice actually demonstrates
// THAT language. Keyed by the language PREFIX (the part before any region tag:
// "pt-br" → "pt", "en-gb" → "en").
//
// Supertonic 3 consumes Unicode text directly, so its previews can use native
// text for every supported language. Other engines still fall back to English
// when their phonemizer does not support a language well enough.
const DEMO_SENTENCE_BY_LANG: Record<string, string> = {
  ar: "مرحبا، هذا عرض قصير لتوليد الكلام.",
  bg: "Здравейте, това е кратка демонстрация на синтез на реч.",
  cs: "Dobrý den, toto je krátká ukázka syntézy řeči.",
  da: "Hej, dette er en kort demonstration af talesyntese.",
  de: "Hallo, dies ist eine kurze Demonstration der Sprachsynthese.",
  el: "Γεια σας, αυτή είναι μια σύντομη επίδειξη σύνθεσης ομιλίας.",
  en: TEST_SAMPLE_FALLBACK,
  es: "Hola, esta es una breve demostración de síntesis de voz.",
  et: "Tere, see on lühike kõnesünteesi näide.",
  fi: "Hei, tämä on lyhyt puhesynteesin esittely.",
  fr: "Bonjour, ceci est une courte démonstration de synthèse vocale.",
  hi: "नमस्ते, यह वाक् संश्लेषण का एक छोटा सा उदाहरण है।",
  hr: "Pozdrav, ovo je kratka demonstracija sinteze govora.",
  hu: "Üdvözlöm, ez egy rövid beszédszintézis-bemutató.",
  id: "Halo, ini adalah demo singkat sintesis suara.",
  it: "Ciao, questa è una breve dimostrazione di sintesi vocale.",
  ja: "こんにちは。これは短い音声合成のデモです。",
  ko: "안녕하세요. 이것은 짧은 음성 합성 데모입니다.",
  lt: "Sveiki, tai trumpas kalbos sintezės demonstravimas.",
  lv: "Sveiki, šī ir īsa runas sintēzes demonstrācija.",
  nl: "Hallo, dit is een korte demonstratie van spraaksynthese.",
  pl: "Dzień dobry, to krótka demonstracja syntezy mowy.",
  pt: "Olá, esta é uma breve demonstração de síntese de voz.",
  ro: "Bună, aceasta este o scurtă demonstrație de sinteză vocală.",
  ru: "Здравствуйте, это короткая демонстрация синтеза речи.",
  sk: "Dobrý deň, toto je krátka ukážka syntézy reči.",
  sl: "Pozdravljeni, to je kratek prikaz sinteze govora.",
  sv: "Hej, det här är en kort demonstration av talsyntes.",
  tr: "Merhaba, bu kısa bir konuşma sentezi demosudur.",
  uk: "Вітаю, це коротка демонстрація синтезу мовлення.",
  vi: "Xin chào, đây là bản demo ngắn về tổng hợp giọng nói.",
};

// Resolve the demo line for a voice's language: native sentence when we have one
// AND can pronounce it, else the (English) i18n sample or the pangram fallback.
export function demoSentenceForLang(lang: string, i18nSample: string): string {
  const prefix = lang.split("-")[0]?.toLowerCase() ?? "";
  return DEMO_SENTENCE_BY_LANG[prefix] || i18nSample || TEST_SAMPLE_FALLBACK;
}

// Voice ids encode language as a short prefix ("af_heart" → "a" → "en-us").
// When the catalog response provides an explicit `language` field we use that;
// this fallback only fires if the field is missing.
export function deriveLanguage(voiceId: string): string {
  const prefix = voiceId.slice(0, 1).toLowerCase();
  switch (prefix) {
    case "a":
      return "en-us";
    case "b":
      return "en-gb";
    case "e":
      return "es";
    case "f":
      return "fr-fr";
    case "h":
      return "hi";
    case "i":
      return "it";
    case "j":
      return "ja";
    case "p":
      return "pt-br";
    case "z":
      return "zh";
    default:
      return "en-us";
  }
}

// Short country/region code shown as the group-header badge and on the
// selected voice in the (closed) trigger. Falls back to the language code so
// an unknown future locale still gets *a* badge.
const REGION_BADGE: Record<string, string> = {
  ar: "AR",
  bg: "BG",
  cs: "CS",
  da: "DA",
  de: "DE",
  el: "EL",
  en: "EN",
  "en-us": "US",
  "en-gb": "UK",
  es: "ES",
  et: "ET",
  fi: "FI",
  fr: "FR",
  hi: "HI",
  hr: "HR",
  hu: "HU",
  id: "ID",
  it: "IT",
  ja: "JP",
  ko: "KO",
  lt: "LT",
  lv: "LV",
  cmn: "ZH",
  nl: "NL",
  pl: "PL",
  pt: "PT",
  "pt-br": "BR",
  ro: "RO",
  ru: "RU",
  sk: "SK",
  sl: "SL",
  sv: "SV",
  tr: "TR",
  uk: "UK",
  vi: "VI",
};

export function regionBadge(language: string): string {
  return (
    REGION_BADGE[language] ??
    language.split("-")[0]?.toUpperCase() ??
    language.toUpperCase()
  );
}

// Catalog labels already suffix the country ("Heart (US)"); under a country
// header that suffix is redundant, so strip a trailing parenthetical for the
// row text. The badge keeps the country legible in the closed trigger.
const TRAILING_PAREN_RE = /\s*\([^)]*\)\s*$/;

export function stripRegionSuffix(label: string): string {
  return label.replace(TRAILING_PAREN_RE, "").trim() || label;
}

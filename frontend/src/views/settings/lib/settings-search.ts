import { useTranslations } from "use-intl";
import { jaroWinkler } from "@/shared/lib/fuzzy-match";

/**
 * Acceptance bar for a fuzzy (typo-tolerant) token match in the settings
 * search. Mirrors the dictionary's Jaro-Winkler matcher
 * (`shared/lib/fuzzy-match`) — the same scorer that powers word correction —
 * but a hair more lenient than the dictionary's 0.88 since surfacing one extra
 * tab on a near-miss query is cheap, whereas a wrong word substitution is not.
 */
export const SETTINGS_SEARCH_JW_THRESHOLD = 0.85;

// Fuzzy scoring only kicks in for query tokens this long. Short tokens (≤ 3
// chars, e.g. acronyms like "vad" / "tts") are matched by exact/prefix only —
// Jaro-Winkler is far too generous on 2–3 char inputs (e.g. "ai" scores ~0.83
// against "main"), which would flood the list with false positives.
const MIN_FUZZY_LEN = 4;

// Words are letters/digits — punctuation and brackets (e.g. "OpenRouter
// (Cloud)") are dropped so they don't fuse into adjacent tokens.
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

function tokenize(text: string): string[] {
	return text.toLowerCase().match(TOKEN_RE) ?? [];
}

// True iff query token `qt` is satisfied by some haystack token: an exact
// prefix (covers "lang" → "language", "disp" → "display") or — for long enough
// tokens — a Jaro-Winkler near-match (covers typos like "dispaly" → "display").
function someTokenMatches(qt: string, hayTokens: readonly string[]): boolean {
	const fuzzy = qt.length >= MIN_FUZZY_LEN;
	return hayTokens.some(
		(ht) => ht.startsWith(qt) || (fuzzy && jaroWinkler(qt, ht) >= SETTINGS_SEARCH_JW_THRESHOLD)
	);
}

/**
 * Fuzzy settings-search predicate. A tab matches when its searchable text
 * (label + tooltip + section/setting keywords) contains the raw query as a
 * substring (handles partial phrases) OR every query token has a haystack token
 * it matches by prefix or Jaro-Winkler. Empty query matches everything.
 */
export function matchesSearchQuery(haystack: string, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (q.length === 0) {
		return true;
	}
	const hay = haystack.toLowerCase();
	if (hay.includes(q)) {
		return true;
	}
	const queryTokens = tokenize(q);
	if (queryTokens.length === 0) {
		return false;
	}
	const hayTokens = tokenize(hay);
	return queryTokens.every((qt) => someTokenMatches(qt, hayTokens));
}

/**
 * Per-tab search keywords: the section headings and key setting names a tab
 * contains, so the sidebar search surfaces a tab by its *contents*, not just
 * its label/tooltip (e.g. "display" → General, which holds the Display
 * section). Reuses existing localized message keys so the index stays
 * translated for free; a few language-neutral acronyms ("vad", "tts", "stt")
 * are appended literally since their spelled-out labels don't contain them.
 *
 * Note the Model tab also hosts the LLM post-processing and TTS sections, so
 * its keywords pull from those namespaces too.
 */
export function useSettingsSearchKeywords(): Record<string, string> {
	const tg = useTranslations("general");
	const tm = useTranslations("model");
	const ta = useTranslations("audio");
	const th = useTranslations("hotkey");
	const tq = useTranslations("quality");
	const ti = useTranslations("integrations");
	const tHist = useTranslations("history");
	const tAbout = useTranslations("about");
	const tDict = useTranslations("dictionary");
	const tSnip = useTranslations("snippets");
	const tLlm = useTranslations("llm");
	const tTts = useTranslations("tts");

	return {
		general: [
			tg("recording"),
			tg("display"),
			tg("startup"),
			tg("recordingMode"),
			tg("language"),
			tg("wakeWord"),
			tg("visualizerType"),
			tg("overlayMode"),
			tg("muteSystemAudio"),
			tg("speakerDiarization"),
			tg("recordingSound"),
			tg("loopbackDevice"),
			tg("showRecordingOverlay"),
			tg("liveTranscriptionDisplay"),
			tg("startOnLogin"),
			tg("sendCrashReports"),
		].join(" "),
		model: [
			tm("mainModel"),
			tm("realtimeModelSection"),
			tm("device"),
			tm("language"),
			tm("translateToEnglish"),
			tm("modelUnloadTimeout"),
			tm("quantization"),
			tLlm("title"),
			tLlm("provider"),
			tLlm("providerOllama"),
			tLlm("providerOpenRouter"),
			tLlm("subDictationTitle"),
			tLlm("subTransformTitle"),
			tTts("title"),
			tTts("voice"),
			tTts("speed"),
			ti("sourceLabel"),
			ti("sourceLocal"),
			ti("sourceCloud"),
			"stt tts",
		].join(" "),
		audio: [
			ta("inputDevice"),
			ta("outputDevice"),
			ta("advancedTitle"),
			ta("vad"),
			ta("device"),
			th("configuration"),
			"vad",
		].join(" "),
		quality: [
			tq("smartEndpoint"),
			tq("sentencePauses"),
			tq("formatting"),
			tg("contextAwarenessSection"),
			tg("fileTranscription"),
			tg("pasteBehaviorTitle"),
			ta("vad"),
			"vad",
		].join(" "),
		dictionary: [
			tDict("title"),
			tDict("term"),
			tDict("replacement"),
			tDict("autoAddTitle"),
			tDict("thresholdLabel"),
		].join(" "),
		snippets: [tSnip("title"), tSnip("trigger"), tSnip("expansion")].join(" "),
		history: [
			tHist("summaryTitle"),
			tHist("heatmapTitle"),
			tHist("tableTitle"),
			tHist("summaryTotalWords"),
			tHist("summarySpeakingTime"),
		].join(" "),
		integrations: [
			ti("title"),
			ti("openai"),
			ti("elevenlabs"),
			ti("cloudModels"),
			ti("sourceLabel"),
			ti("getApiKey"),
			"api key cloud",
		].join(" "),
		about: [
			tAbout("appInfoTitle"),
			tAbout("appVersion"),
			tAbout("licenseTitle"),
			tAbout("noticesTitle"),
			tAbout("updatesTitle"),
			tAbout("receivePrereleaseUpdates"),
		].join(" "),
	};
}

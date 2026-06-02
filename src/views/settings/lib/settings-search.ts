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
 * Tabs follow the transcript's pipeline (Recording → Model → Processing →
 * Vocabulary → Output) plus cross-cutting tabs (Shortcuts, Appearance, History,
 * Integrations, About). Many settings persist under the shared `general`/`quality`/
 * `audio` store slices regardless of which tab renders them, so the keyword
 * strings pull from whatever namespaces a tab's controls actually use.
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
		recording: [
			tg("recording"),
			tg("recordingMode"),
			tg("wakeWord"),
			tg("loopbackDevice"),
			ta("inputDevice"),
			ta("device"),
			ta("advancedTitle"),
			ta("vad"),
			tq("smartEndpoint"),
			tq("sentencePauses"),
			"vad ptt push to talk toggle listen wake word microphone endpoint silence",
		].join(" "),
		model: [
			tm("mainModel"),
			tm("realtimeModelSection"),
			tm("device"),
			tm("language"),
			tm("translateToEnglish"),
			tm("modelUnloadTimeout"),
			tm("quantization"),
			tg("speakerDiarization"),
			"stt model whisper transcription diarization compute",
		].join(" "),
		processing: [
			tLlm("title"),
			tLlm("provider"),
			tLlm("providerOllama"),
			tLlm("providerOpenRouter"),
			tLlm("subDictationTitle"),
			tLlm("subTransformTitle"),
			tq("formatting"),
			tg("contextAwarenessSection"),
			"llm cleanup grammar tone transform modifiers context formatting",
		].join(" "),
		vocabulary: [
			tDict("title"),
			tDict("term"),
			tDict("replacement"),
			tDict("autoAddTitle"),
			tDict("thresholdLabel"),
			tSnip("title"),
			tSnip("trigger"),
			tSnip("expansion"),
			"dictionary snippets vocabulary replacement expansion",
		].join(" "),
		output: [
			tg("pasteBehaviorTitle"),
			tg("fileTranscription"),
			tg("recordingSound"),
			tg("muteSystemAudio"),
			ta("outputDevice"),
			tTts("title"),
			tTts("voice"),
			tTts("speed"),
			"auto submit paste output device speaker text to speech tts srt",
		].join(" "),
		shortcuts: [
			th("configuration"),
			th("pushToTalkKey"),
			th("repasteKey"),
			th("shortcutsLegendLabel"),
			tTts("hotkeyLabel"),
			tLlm("subTransformTitle"),
			"hotkey shortcut keybinding combo",
		].join(" "),
		appearance: [
			tg("display"),
			tg("language"),
			tg("visualizerType"),
			tg("overlayMode"),
			tg("showRecordingOverlay"),
			tg("liveTranscriptionDisplay"),
			"theme visualizer overlay appearance display language live transcription",
		].join(" "),
		history: [
			tHist("summaryTitle"),
			tHist("heatmapTitle"),
			tHist("tableTitle"),
			tHist("summaryTotalWords"),
			tHist("summarySpeakingTime"),
		].join(" "),
		integrations: [
			ti("title"),
			ti("llmSectionTitle"),
			ti("sttSectionTitle"),
			ti("openai"),
			ti("elevenlabs"),
			ti("cloudModels"),
			ti("sourceLabel"),
			ti("getApiKey"),
			"api key cloud llm openrouter ollama speech to text transcription",
		].join(" "),
		about: [
			tAbout("appInfoTitle"),
			tAbout("appVersion"),
			tAbout("licenseTitle"),
			tAbout("noticesTitle"),
			tAbout("updatesTitle"),
			tAbout("receivePrereleaseUpdates"),
			tg("startOnLogin"),
			tg("sendCrashReports"),
			"startup login crash reports reset defaults updates version license",
		].join(" "),
	};
}

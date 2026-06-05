import { useTranslations } from "use-intl";
import Fuse, { type IFuseOptions } from "fuse.js";

/**
 * Acceptance bar for a Fuse.js typo-tolerant token match in settings search.
 * Lower is stricter; this accepts common transpositions
 * ("dispaly" -> "display") without matching unrelated long tokens in the
 * sidebar's small keyword corpus.
 */
const SETTINGS_SEARCH_FUSE_THRESHOLD = 0.3;

// Fuzzy scoring only kicks in for query tokens this long. Short tokens (<= 3
// chars, e.g. acronyms like "vad" / "tts") are matched by exact/prefix only so
// a short, non-substring query like "ai" does not light up unrelated tabs.
const MIN_FUZZY_LEN = 4;

// Words are letters/digits — punctuation and brackets (e.g. "OpenRouter
// (Cloud)") are dropped so they don't fuse into adjacent tokens.
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

const SETTINGS_SEARCH_FUSE_OPTIONS: IFuseOptions<string> = {
	threshold: SETTINGS_SEARCH_FUSE_THRESHOLD,
	ignoreLocation: true,
	minMatchCharLength: MIN_FUZZY_LEN,
	shouldSort: false,
};

function tokenize(text: string): string[] {
	return text.toLowerCase().match(TOKEN_RE) ?? [];
}

// True iff query token `qt` is satisfied by some haystack token: an exact
// prefix (covers "lang" -> "language", "disp" -> "display") or, for long
// enough tokens, a Fuse.js near-match (covers typos like "dispaly" -> "display").
function tokenHasPrefixMatch(
	qt: string,
	hayTokens: readonly string[],
): boolean {
	return hayTokens.some((ht) => ht.startsWith(qt));
}

function fuzzyTokenMatches(
	qt: string,
	getTokenFuse: () => Fuse<string>,
): boolean {
	if (qt.length < MIN_FUZZY_LEN) {
		return false;
	}
	return getTokenFuse().search(qt, { limit: 1 }).length > 0;
}

function someTokenMatches(
	qt: string,
	hayTokens: readonly string[],
	getTokenFuse: () => Fuse<string>,
): boolean {
	return (
		tokenHasPrefixMatch(qt, hayTokens) || fuzzyTokenMatches(qt, getTokenFuse)
	);
}

/**
 * Fuzzy settings-search predicate. A tab matches when its searchable text
 * (label + tooltip + section/setting keywords) contains the raw query as a
 * substring (handles partial phrases) OR every query token has a haystack token
 * it matches by prefix or Fuse.js. Empty query matches everything.
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
	let tokenFuse: Fuse<string> | null = null;
	const getTokenFuse = (): Fuse<string> => {
		tokenFuse ??= new Fuse(hayTokens, SETTINGS_SEARCH_FUSE_OPTIONS);
		return tokenFuse;
	};
	return queryTokens.every((qt) =>
		someTokenMatches(qt, hayTokens, getTokenFuse),
	);
}

/**
 * Per-tab search keywords: the section headings and key setting names a tab
 * contains, so the sidebar search surfaces a tab by its *contents*, not just
 * its label/tooltip (e.g. "display" → General, which holds the Display
 * section). Reuses existing localized message keys so the index stays
 * translated for free; a few language-neutral acronyms ("vad", "tts", "stt")
 * are appended literally since their spelled-out labels don't contain them.
 *
 * Tabs follow the transcript's pipeline (Recording → Transcription →
 * Processing → Vocabulary → Delivery / Read Aloud) plus cross-cutting tabs
 * (Shortcuts, Appearance, History, Integrations, About). Many settings persist
 * under the shared `general`/`quality`/`audio` store slices regardless of which
 * tab renders them, so the keyword strings pull from whatever namespaces a
 * tab's controls actually use.
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
			"auto submit paste delivery clipboard file export output srt txt",
		].join(" "),
		readAloud: [
			ta("outputDevice"),
			tg("recordingSound"),
			tg("muteSystemAudio"),
			tTts("title"),
			tTts("model"),
			tTts("voice"),
			tTts("speed"),
			tTts("hotkeyLabel"),
			"read aloud playback output device speaker chime sound text to speech tts voice",
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

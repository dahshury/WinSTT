import { useTranslations } from "use-intl";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";

/**
 * Fuzzy settings-search predicate. A tab matches when its searchable text
 * (label + tooltip + section/setting keywords) matches by substring, prefix,
 * compact aliases, or bounded typo tolerance. Empty query matches everything.
 */
export function matchesSearchQuery(haystack: string, query: string): boolean {
	return matchesFuzzySearch(haystack, query);
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
			tg("recordingSound"),
			ta("inputDevice"),
			ta("device"),
			ta("advancedTitle"),
			ta("vad"),
			tq("smartEndpoint"),
			tq("sentencePauses"),
			"vad ptt push to talk toggle listen wake word microphone endpoint silence recording sound chime",
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
			tLlm("modelAssistanceTitle"),
			tLlm("modelAssistanceCleanup"),
			tLlm("subTransformTitle"),
			tg("contextAwarenessSection"),
			"llm cleanup grammar tone transform modifiers formatting punctuation code commands symbols context assistance model selected apps allow list deny list",
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
			ta("outputDevice"),
			tg("muteSystemAudio"),
			"auto submit paste delivery clipboard file export output srt txt playback device speaker audio ducking system audio",
		].join(" "),
		readAloud: [
			tTts("title"),
			tTts("model"),
			tTts("voice"),
			tTts("speed"),
			tTts("hotkeyLabel"),
			"read aloud text to speech tts voice speed",
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
			ti("elevenlabs"),
			ti("cloudModels"),
			ti("sourceLabel"),
			ti("getApiKey"),
			"api key cloud llm openrouter ollama speech to text transcription",
		].join(" "),
		about: [
			tAbout("appInfoTitle"),
			tAbout("appVersion"),
			tAbout("updatesTitle"),
			tAbout("receivePrereleaseUpdates"),
			tAbout("diagnosticsTitle"),
			tAbout("openLogsFolder"),
			tAbout("saveDiagnosticBundle"),
			tg("startOnLogin"),
			tg("sendCrashReports"),
			"startup login crash reports reset defaults updates version logs diagnostics diagnostic bundle support",
		].join(" "),
	};
}

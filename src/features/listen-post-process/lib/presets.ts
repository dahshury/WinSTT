/**
 * Listening-session post-processing presets.
 *
 * These are DISTINCT from the dictation/transforms presets in the
 * post-processing tab: those shape the USER'S own speech before pasting,
 * while these shape a transcript of audio the user LISTENED to (a meeting,
 * a call, a podcast) after the fact — different intent, different prompts.
 * Labels are i18n keys under the `history` namespace; instruction bodies stay
 * English like every other prompt in the app (the system prompt instructs the
 * model to answer in the transcript's language).
 */
/** i18n keys (under `history`) the built-in presets label themselves with. */
export type ListenPresetLabelKey =
	| "listenPresetActionItems"
	| "listenPresetKeyQuotes"
	| "listenPresetMeetingNotes"
	| "listenPresetQa"
	| "listenPresetStudyNotes"
	| "listenPresetSummary";

export interface ListenPostProcessPreset {
	id: string;
	instructions: string;
	labelKey: ListenPresetLabelKey;
}

/** Sentinel picker entry: free-form instructions typed by the user. */
export const CUSTOM_PRESET_ID = "custom";

export const LISTEN_POST_PROCESS_PRESETS: readonly ListenPostProcessPreset[] = [
	{
		id: "meetingNotes",
		labelKey: "listenPresetMeetingNotes",
		instructions:
			"Turn the transcript into structured meeting notes: a one-paragraph summary, the topics discussed with the key points under each, the decisions made, and an 'Action items' checklist with the responsible person when identifiable.",
	},
	{
		id: "summary",
		labelKey: "listenPresetSummary",
		instructions:
			"Summarize the transcript into a concise overview: the main topics, the key takeaways, and any conclusions reached.",
	},
	{
		id: "actionItems",
		labelKey: "listenPresetActionItems",
		instructions:
			"Extract every action item, task, commitment, and deadline mentioned in the transcript as a checklist, each with the responsible person when identifiable.",
	},
	{
		id: "studyNotes",
		labelKey: "listenPresetStudyNotes",
		instructions:
			"Turn the transcript into structured study notes: clear headings per topic, bullet points for the important facts and explanations, and a short list of key terms with definitions.",
	},
	{
		id: "qa",
		labelKey: "listenPresetQa",
		instructions:
			"Extract the questions raised in the transcript and the answer given to each, as a Q&A list. List unanswered questions separately at the end.",
	},
	{
		id: "keyQuotes",
		labelKey: "listenPresetKeyQuotes",
		instructions:
			"Extract the most important or quotable statements from the transcript verbatim, each attributed to its speaker when identifiable.",
	},
];

/**
 * The instruction text a picker selection resolves to, or `null` when the
 * selection cannot run (unknown preset, or custom with nothing typed).
 */
export function resolveInstructions(
	presetId: string,
	customInstructions: string,
): string | null {
	if (presetId === CUSTOM_PRESET_ID) {
		const trimmed = customInstructions.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	return (
		LISTEN_POST_PROCESS_PRESETS.find((preset) => preset.id === presetId)
			?.instructions ?? null
	);
}

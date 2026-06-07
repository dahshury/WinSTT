const HISTORY_TAG_LABELS: Record<string, string> = {
	ai_prompt: "AI Prompt",
	code: "Code",
	document: "Document",
	email: "Email",
	meeting: "Meeting",
	note: "Note",
	other: "Other",
	personal_message: "Personal",
	task: "Task",
	work_message: "Work",
};

export const SENSITIVE_HISTORY_LABEL = "Sensitive";

export function historyTagLabel(tag: string | null | undefined): string | null {
	if (!tag) {
		return null;
	}
	return HISTORY_TAG_LABELS[tag] ?? null;
}

export function hasPrivacyMarkers(
	markers: string[] | null | undefined,
): boolean {
	return Array.isArray(markers) && markers.length > 0;
}

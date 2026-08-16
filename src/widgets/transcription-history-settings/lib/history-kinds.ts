import type { HistoryTableItem } from "../model/history-table-types";

/** The history kinds the tab can be scoped to. "all" is the default. */
export type HistoryKind = "all" | "history" | "transforms" | "tts";

export interface HistoryKindOption {
	/** Rows of this kind currently stored — drives the Clear button's disabled
	 *  state, since there is nothing to clear at zero. */
	count: number;
	id: HistoryKind;
	label: string;
}

/** Row predicate per kind. "all" passes everything through. */
export function matchesHistoryKind(
	row: HistoryTableItem,
	kind: HistoryKind,
): boolean {
	if (kind === "all") {
		return true;
	}
	if (kind === "history") {
		return row.kind === "transcription";
	}
	if (kind === "transforms") {
		return row.kind === "transform";
	}
	return row.kind === "tts";
}

export function buildHistoryKindOptions({
	labels,
	transcriptionCount,
	transformCount,
	ttsCount,
}: {
	labels: Record<HistoryKind, string>;
	transcriptionCount: number;
	transformCount: number;
	ttsCount: number;
}): HistoryKindOption[] {
	return [
		{
			count: transcriptionCount + transformCount + ttsCount,
			id: "all",
			label: labels.all,
		},
		{ count: transcriptionCount, id: "history", label: labels.history },
		{ count: transformCount, id: "transforms", label: labels.transforms },
		{ count: ttsCount, id: "tts", label: labels.tts },
	];
}

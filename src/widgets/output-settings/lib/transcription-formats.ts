import type { GeneralSettings } from "@/entities/setting";

export type FileTranscriptionFormat =
	GeneralSettings["fileTranscriptionFormats"][number];

type FormatSettings = Pick<GeneralSettings, "fileTranscriptionFormats">;

export function resolveSelectedFormats(
	general: FormatSettings,
): FileTranscriptionFormat[] {
	const configured = general.fileTranscriptionFormats;
	return configured.length > 0 ? [...new Set(configured)] : ["txt"];
}

export function toggleTranscriptionFormat(
	selected: readonly FileTranscriptionFormat[],
	format: FileTranscriptionFormat,
): FileTranscriptionFormat[] {
	if (selected.includes(format)) {
		return selected.length === 1
			? [...selected]
			: selected.filter((value) => value !== format);
	}
	return [...selected, format];
}

export function transcriptionFormatsEqual(
	left: readonly FileTranscriptionFormat[],
	right: readonly FileTranscriptionFormat[],
): boolean {
	return (
		left.length === right.length &&
		left.every((format, index) => format === right[index])
	);
}

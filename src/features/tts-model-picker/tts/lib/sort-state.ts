import type { TtsModelInfo } from "@/entities/tts-catalog";
import {
	ascendingOrName,
	makeNameComparator,
	makeSortState,
	type SortValue,
} from "@/shared/ui/model-picker/core/lib/sort-state";

export type TtsSortKey = "speed" | "quality" | "size" | "voices" | "name";
export type TtsSortValue = SortValue<TtsSortKey>;

export const TTS_SORT_KEYS = [
	"speed",
	"quality",
	"size",
	"voices",
	"name",
] as const;

export const TTS_SORT_CHIP_LABEL: Record<TtsSortKey, string> = {
	speed: "Speed",
	quality: "Quality",
	size: "Size",
	voices: "Voices",
	name: "Name",
};

export const TTS_SORT_HEADER_LABEL: Record<TtsSortKey, string> = {
	speed: "Speed · fastest first",
	quality: "Quality · highest first",
	size: "Download size · smallest first",
	voices: "Voice count · most first",
	name: "Name · A–Z",
};

function smallestDownloadBytes(model: TtsModelInfo): number {
	const known = Object.values(model.sizeBytesByQuantization).filter(
		(bytes) => bytes > 0,
	);
	return known.length > 0 ? Math.min(...known) : Number.POSITIVE_INFINITY;
}

const byName = makeNameComparator((model: TtsModelInfo) => model.displayName);

const COMPARATORS: Record<
	TtsSortKey,
	(a: TtsModelInfo, b: TtsModelInfo) => number
> = {
	speed: (a, b) => b.speedScore - a.speedScore || byName(a, b),
	quality: (a, b) => b.qualityScore - a.qualityScore || byName(a, b),
	size: (a, b) =>
		ascendingOrName(
			smallestDownloadBytes(a),
			smallestDownloadBytes(b),
			a,
			b,
			byName,
		),
	voices: (a, b) => b.numVoices - a.numVoices || byName(a, b),
	name: byName,
};

export const { sortModels: sortTtsModels } = makeSortState(COMPARATORS);

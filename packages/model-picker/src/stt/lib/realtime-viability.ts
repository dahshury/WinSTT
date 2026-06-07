import type { ModelInfo } from "@/entities/model-catalog";

/**
 * Models above this parameter count are too heavy for live preview transcription
 * to keep up with speech — they're realtime-capable in the "can technically run"
 * sense the server reports, but they don't produce text fast enough for a
 * dictation UX. Picked just above NeMo Parakeet 0.6B (600M) so fast RNNT/CTC
 * models stay in, while Whisper Medium (769M) and Whisper Large (1.5B) are out.
 */
const REALTIME_MAX_PARAMS = 700_000_000;

const SIZE_LABEL_RE = /^([\d.]+)([MB])$/i;

const MILLION = 1_000_000;
const UNIT_MULTIPLIER: Record<string, number> = {
	M: MILLION,
	B: 1_000_000_000,
};

function scaleByUnit(num: number, unit: string | undefined): number {
	const multiplier = UNIT_MULTIPLIER[(unit ?? "").toUpperCase()] ?? MILLION;
	return num * multiplier;
}

function parsedParts(
	label: string,
): { num: number; unit: string | undefined } | null {
	const match = label.match(SIZE_LABEL_RE);
	if (!match) {
		return null;
	}
	return { num: Number.parseFloat(match[1] ?? ""), unit: match[2] };
}

/** Parse server-emitted size labels like "39M", "244M", "1.5B" to a param count. */
export function parseSizeLabel(label: string): number | null {
	const parts = parsedParts(label);
	if (!(parts && Number.isFinite(parts.num))) {
		return null;
	}
	return scaleByUnit(parts.num, parts.unit);
}

/**
 * True when a model is small enough to drive the live-preview transcription
 * comfortably. `preview_capable` from the catalog is necessary but not
 * sufficient: it says the backend can produce live preview, not that the model
 * will keep up comfortably on every machine. We apply a parameter-count
 * threshold so Whisper Medium / Large don't get flagged as live-preview picks.
 *
 * When the size label is empty or unparseable (some Russian models), we fall
 * back to the preview-capable flag because the model author opted in deliberately.
 */
export function isRealtimeViable(model: ModelInfo): boolean {
	if (!model.previewCapable) {
		return false;
	}
	const params = parseSizeLabel(model.sizeLabel);
	if (params === null) {
		return true;
	}
	return params <= REALTIME_MAX_PARAMS;
}

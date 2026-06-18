/**
 * Stable semantic color slots for diarized speakers.
 *
 * The concrete palette lives in `globals.css` as `--color-speaker-*` tokens.
 * Beyond 8 speakers, slots wrap; collision is rare in real conversations and
 * acceptable here.
 */
const SPEAKER_PALETTE: readonly string[] = [
	"var(--color-speaker-1)",
	"var(--color-speaker-2)",
	"var(--color-speaker-3)",
	"var(--color-speaker-4)",
	"var(--color-speaker-5)",
	"var(--color-speaker-6)",
	"var(--color-speaker-7)",
	"var(--color-speaker-8)",
];

/** Return the palette color for `speaker`; negative ids map to "muted". */
export function colorForSpeaker(speaker: number): string {
	if (speaker < 0) {
		return "currentColor";
	}
	const palette = SPEAKER_PALETTE;
	return palette[speaker % palette.length] ?? "currentColor";
}

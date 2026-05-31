/**
 * Stable color palette for diarized speakers.
 *
 * Picked for contrast on both light and dark backgrounds, and for distinct
 * pairwise hue separation up to 8 concurrent speakers. Beyond 8, the palette
 * wraps — collision is rare in real conversations and acceptable here
 * (the alternative, generating arbitrary HSL on the fly, lands on muddy
 * mid-saturation greens for most ids).
 */
const SPEAKER_PALETTE: readonly string[] = [
	"#38bdf8", // sky-400
	"#fb923c", // orange-400
	"#34d399", // emerald-400
	"#f472b6", // pink-400
	"#facc15", // yellow-400
	"#a78bfa", // violet-400
	"#fb7185", // rose-400
	"#22d3ee", // cyan-400
];

/** Return the palette color for ``speaker``; negative ids map to "muted". */
export function colorForSpeaker(speaker: number): string {
	if (speaker < 0) {
		return "currentColor";
	}
	const palette = SPEAKER_PALETTE;
	return palette[speaker % palette.length] ?? "currentColor";
}

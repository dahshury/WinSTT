/**
 * Synthetic speech envelope (0–~0.28) used to drive the preview store.
 * Three incommensurate sine bands roughly mimic syllable/word cadence; the
 * floor stays above the "speaking" threshold (0.02, see use-agent-state) so a
 * hovered preview holds the speaking state for its whole hover.
 */
export function demoSpeechLevel(tSeconds: number): number {
	const envelope =
		0.12 +
		0.08 * Math.sin(tSeconds * 2.1) +
		0.05 * Math.sin(tSeconds * 5.3 + 1.7) +
		0.03 * Math.sin(tSeconds * 9.7 + 0.4);
	return Math.max(0.04, envelope);
}

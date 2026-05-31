/**
 * On-demand demo clips for the settings hover-previews.
 *
 * The clips are NOT bundled in the installer — they're fetched from the public
 * docs site (which doubles as a CDN) only when the user hovers a control, and
 * fail soft when offline. Keeping them remote keeps the installer small and
 * lets us refresh the demos without shipping an update.
 */
export const DEMO_PREVIEW_BASE = "https://winstt.dahshury.com/demos";

/** Resolve a demo name (e.g. "ptt") to its remote .webm URL. */
export function demoPreviewUrl(name: string): string {
	return `${DEMO_PREVIEW_BASE}/${name}.webm`;
}

/**
 * Known demo clip names (mirrors the files published to <docs>/public/demos/).
 * Used only for editor autocomplete on `<DemoPreview demo={...} />`.
 */
export type DemoName =
	| "ptt"
	| "toggle"
	| "listen"
	| "wakeword"
	| "llm-dictation"
	| "llm-transform"
	| "auto-submit"
	| "dictionary"
	| "snippets"
	| "transcribe-file"
	| "viz-bar"
	| "viz-grid"
	| "viz-radial"
	| "viz-wave"
	| "viz-aura"
	| "overlay-floating"
	| "overlay-island";

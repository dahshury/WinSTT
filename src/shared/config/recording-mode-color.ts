/**
 * Concrete sRGB bridge for the per-recording-mode accent color.
 *
 * The brand palette lives in `src/app/styles/globals.css` as the OKLch tokens
 * `--color-recording-mode-{ptt,toggle,listen,wakeword}` (ptt→accent,
 * toggle→warning, listen→success, wakeword→a warm orange). CSS consumers read
 * those tokens directly; this file is the ONE sanctioned place that restates
 * them as concrete hex/RGB, for consumers that cannot resolve a CSS variable:
 *   - Audio visualizer (`@/features/audio-visualizer`) needs an `#rrggbb`
 *     string for the bar `style` and normalized RGB floats for the wave/aura
 *     canvas shaders.
 *
 * These values are the sRGB conversions of the OKLch tokens, kept in lockstep
 * by `recording-mode-color.brand-sync.test.ts` — do not hand-tune them away
 * from the brand tokens; edit the tokens in globals.css instead.
 */

export type RecordingMode = "ptt" | "toggle" | "listen" | "wakeword";

export const RECORDING_MODE_COLOR_HEX = {
	ptt: "#3a81f6", // accent — oklch(62% 0.19 260)
	toggle: "#e8b700", // warning — oklch(80% 0.17 90)
	listen: "#2eb45c", // success — oklch(68% 0.17 150)
	wakeword: "#f16a00", // wakeword — oklch(68% 0.19 48)
} as const satisfies Record<RecordingMode, `#${string}`>;

export const RECORDING_MODE_COLOR_RGB = {
	ptt: [58, 129, 246],
	toggle: [232, 183, 0],
	listen: [46, 180, 92],
	wakeword: [241, 106, 0],
} as const satisfies Record<RecordingMode, readonly [number, number, number]>;

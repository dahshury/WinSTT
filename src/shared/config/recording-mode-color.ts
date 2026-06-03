/**
 * Single source of truth for the per-recording-mode accent color.
 *
 * The same hex/RGB values surface in three places, so a renderer pill, the
 * settings switcher, and the tray icon always agree on which mode is active:
 *   - Settings switcher (`@/shared/ui/switcher`) tints labels and pressed bg
 *   - Audio visualizer (`@/features/audio-visualizer`) overrides bar color
 *   - the reference tray/taskbar indicator (`@electron/lib/recording-indicator`)
 *     blends the icon with the matching RGB triple
 */

export type RecordingMode = "ptt" | "toggle" | "listen" | "wakeword";

export const RECORDING_MODE_COLOR_HEX = {
	ptt: "#3b82f6", // blue-500
	toggle: "#facc15", // yellow-400
	listen: "#22c55e", // green-500
	wakeword: "#f97316", // orange-500
} as const satisfies Record<RecordingMode, `#${string}`>;

export const RECORDING_MODE_COLOR_RGB = {
	ptt: [59, 130, 246],
	toggle: [250, 204, 21],
	listen: [34, 197, 94],
	wakeword: [249, 115, 22],
} as const satisfies Record<RecordingMode, readonly [number, number, number]>;

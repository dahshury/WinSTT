// Idle/parse-failure fallback = the brand "teal" waveform token
// (globals.css `--color-teal` → oklch(71% 0.13 245)) in concrete sRGB. The
// visualizer normally renders a recording-mode color; this only surfaces when a
// color is omitted or fails to parse.
const DEFAULT_COLOR = "#53A9ED";
const HEX_COLOR_RE = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/;
const DEFAULT_RGB: [number, number, number] = [
	0x53 / 255,
	0xa9 / 255,
	0xed / 255,
];

export function hexToRgb(hexColor: string): [number, number, number] {
	const match = HEX_COLOR_RE.exec(hexColor);
	if (!match) {
		return [...DEFAULT_RGB];
	}
	// Default values aren't reachable — HEX_COLOR_RE has three required
	// capture groups, so a successful match always exposes r/g/b. The
	// destructuring defaults exist only to widen the inferred type from
	// `string | undefined` to `string`.
	const [, r = "53", g = "a9", b = "ed"] = match;
	return [
		Number.parseInt(r, 16) / 255,
		Number.parseInt(g, 16) / 255,
		Number.parseInt(b, 16) / 255,
	];
}

export { DEFAULT_COLOR as DEFAULT_VISUALIZER_COLOR };

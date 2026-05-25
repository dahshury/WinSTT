const DEFAULT_COLOR = "#1FD5F9";
const HEX_COLOR_RE = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/;
const DEFAULT_RGB: [number, number, number] = [0x1f / 255, 0xd5 / 255, 0xf9 / 255];

export function hexToRgb(hexColor: string): [number, number, number] {
	const match = HEX_COLOR_RE.exec(hexColor);
	if (!match) {
		return [...DEFAULT_RGB];
	}
	// Default values aren't reachable — HEX_COLOR_RE has three required
	// capture groups, so a successful match always exposes r/g/b. The
	// destructuring defaults exist only to widen the inferred type from
	// `string | undefined` to `string`, sparing us a follow-up guard
	// that would have bumped this function's CRAP score.
	const [, r = "1f", g = "d5", b = "f9"] = match;
	return [Number.parseInt(r, 16) / 255, Number.parseInt(g, 16) / 255, Number.parseInt(b, 16) / 255];
}

export { DEFAULT_COLOR as DEFAULT_VISUALIZER_COLOR };

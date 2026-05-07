const DEFAULT_COLOR = "#1FD5F9";
const HEX_COLOR_RE = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/;
const DEFAULT_RGB: [number, number, number] = [0x1f / 255, 0xd5 / 255, 0xf9 / 255];

export function hexToRgb(hexColor: string): [number, number, number] {
	const match = HEX_COLOR_RE.exec(hexColor);
	if (!match) {
		return [...DEFAULT_RGB];
	}
	const [, r, g, b] = match as unknown as [string, string, string, string];
	return [Number.parseInt(r, 16) / 255, Number.parseInt(g, 16) / 255, Number.parseInt(b, 16) / 255];
}

export { DEFAULT_COLOR as DEFAULT_VISUALIZER_COLOR };

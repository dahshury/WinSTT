const MAX_DEVICE_CHARS = 16;

/** Strip driver/loopback suffixes: "LG TV (NVIDIA …) [Loopback]" → "LG TV" */
const DEVICE_SUFFIX_RE = /\s*[([].*/;
export function shortDeviceName(name: string): string {
	return name.replace(DEVICE_SUFFIX_RE, "").trim() || name;
}

/** Truncate to a few letters for the compact footer chip. */
export function abbreviateDevice(name: string): string {
	const short = shortDeviceName(name);
	if (short.length <= MAX_DEVICE_CHARS) {
		return short;
	}
	return `${short.slice(0, MAX_DEVICE_CHARS).trimEnd()}…`;
}

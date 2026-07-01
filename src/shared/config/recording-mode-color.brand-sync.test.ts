import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	RECORDING_MODE_COLOR_HEX,
	RECORDING_MODE_COLOR_RGB,
	type RecordingMode,
} from "./recording-mode-color";

// The brand recording-mode colors are authored ONCE, as OKLch tokens, in
// globals.css. recording-mode-color.ts restates them as concrete sRGB for
// canvas consumers that cannot resolve a CSS variable. This test is the lock
// that keeps the two in sync: it parses the tokens, converts OKLch → sRGB with
// the standard matrices, and asserts the bridge matches. Edit the tokens in
// globals.css and these expectations follow automatically; hand-tuning the
// bridge away from the tokens fails here.

const GLOBALS_CSS = resolve(
	import.meta.dir,
	"../../..",
	"src/app/styles/globals.css",
);

const MODES: readonly RecordingMode[] = ["ptt", "toggle", "listen", "wakeword"];

/** All `--color-foo: value;` declarations from globals.css, first wins. */
function readColorTokens(): Map<string, string> {
	const css = readFileSync(GLOBALS_CSS, "utf8");
	const tokens = new Map<string, string>();
	const re = /(--color-[a-z0-9-]+)\s*:\s*([^;]+);/gi;
	for (const match of css.matchAll(re)) {
		const name = match[1];
		const value = match[2];
		if (name && value && !tokens.has(name)) {
			tokens.set(name, value.trim());
		}
	}
	return tokens;
}

/** Resolve a token to its underlying oklch(...) literal, following var() chains. */
function resolveToOklch(tokens: Map<string, string>, name: string): string {
	let value = tokens.get(name);
	const seen = new Set<string>();
	while (value?.startsWith("var(")) {
		const ref = value.slice(4, value.indexOf(")")).trim();
		if (seen.has(ref)) {
			throw new Error(`cyclic var() chain at ${ref}`);
		}
		seen.add(ref);
		value = tokens.get(ref);
	}
	if (!value) {
		throw new Error(`token ${name} did not resolve to a value`);
	}
	return value;
}

/** Parse `oklch(L% C H)` (alpha ignored) into [L(0..1), C, H(deg)]. */
function parseOklch(literal: string): [number, number, number] {
	const match = /oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/i.exec(literal);
	if (!match) {
		throw new Error(`not an oklch literal: ${literal}`);
	}
	const rawL = Number.parseFloat(match[1] ?? "");
	const L = literal.includes("%") ? rawL / 100 : rawL;
	return [
		L,
		Number.parseFloat(match[2] ?? ""),
		Number.parseFloat(match[3] ?? ""),
	];
}

/** OKLch → sRGB byte triple (Björn Ottosson's matrices + sRGB transfer). */
function oklchToRgb(
	L: number,
	C: number,
	hDeg: number,
): [number, number, number] {
	const h = (hDeg * Math.PI) / 180;
	const a = C * Math.cos(h);
	const b = C * Math.sin(h);
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const l = l_ ** 3;
	const m = m_ ** 3;
	const s = s_ ** 3;
	const lin = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
	const encode = (x: number): number => {
		const c = Math.max(0, Math.min(1, x));
		const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
		return Math.round(srgb * 255);
	};
	return [encode(lin[0] ?? 0), encode(lin[1] ?? 0), encode(lin[2] ?? 0)];
}

function hexToBytes(hex: string): [number, number, number] {
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
}

describe("recording-mode-color brand sync", () => {
	const tokens = readColorTokens();

	test("globals.css defines a --color-recording-mode-* token per mode", () => {
		for (const mode of MODES) {
			expect(tokens.has(`--color-recording-mode-${mode}`)).toBe(true);
		}
	});

	test.each([...MODES])(
		"%s bridge hex equals the sRGB of its brand token",
		(mode: RecordingMode) => {
			const literal = resolveToOklch(tokens, `--color-recording-mode-${mode}`);
			const [L, C, H] = parseOklch(literal);
			const expected = oklchToRgb(L, C, H);
			const actual = hexToBytes(RECORDING_MODE_COLOR_HEX[mode]);
			// Allow ±1/channel for rounding between toolchains.
			for (let i = 0; i < 3; i += 1) {
				expect(
					Math.abs((actual[i] ?? 0) - (expected[i] ?? 0)),
				).toBeLessThanOrEqual(1);
			}
		},
	);

	test("RGB triples stay in lockstep with the HEX map", () => {
		for (const mode of MODES) {
			const rgb: number[] = [...RECORDING_MODE_COLOR_RGB[mode]];
			expect(rgb).toEqual(hexToBytes(RECORDING_MODE_COLOR_HEX[mode]));
		}
	});
});

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Guardrail: every z-index in the app must flow through the unified scale in
 * `z-index.ts` (TS) or `globals.css` (the matching `--z-index-*` tokens).
 *
 * Anything else — raw `z-[\d+]` Tailwind classes, `zIndex: <number>` inline
 * styles, plain `z-index: <number>` in CSS — drifts the scale and reintroduces
 * the kind of stacking bug this consolidation fixed. If a new layer is needed,
 * add it to `z-index.ts` + `globals.css` instead of writing raw values.
 */

const FRONTEND_ROOT = resolve(import.meta.dir, "../../..");
const SCAN_DIRS = [join(FRONTEND_ROOT, "src"), join(FRONTEND_ROOT, "packages")];
const WHITELIST = new Set(
	[
		// The canonical source files are allowed to contain numeric literals —
		// that's literally their job.
		"src/shared/config/z-index.ts",
		"src/shared/config/z-index.test.ts",
		"src/shared/config/z-index-discipline.test.ts",
		"src/app/styles/globals.css",
	].map((p) => p.replaceAll("/", "\\"))
);
const WHITELIST_POSIX = new Set([
	"src/shared/config/z-index.ts",
	"src/shared/config/z-index.test.ts",
	"src/shared/config/z-index-discipline.test.ts",
	"src/app/styles/globals.css",
]);

const SCAN_EXTENSIONS = [".ts", ".tsx", ".css"];
const SKIP_DIRS = new Set([
	"node_modules",
	".next",
	".turbo",
	"dist",
	"build",
	"coverage",
	"playwright-report",
	"stt-server-dist-cpu",
	"stt-server-dist-gpu",
]);

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(entry.name)) {
			continue;
		}
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(path));
		} else if (SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
			out.push(path);
		}
	}
	return out;
}

function relativeNormalized(file: string): string {
	return relative(FRONTEND_ROOT, file).replaceAll("\\", "/");
}

function isWhitelisted(file: string): boolean {
	const relWindows = relative(FRONTEND_ROOT, file);
	const relPosix = relWindows.replaceAll("\\", "/");
	return WHITELIST.has(relWindows) || WHITELIST_POSIX.has(relPosix);
}

const SCAN_FILES = SCAN_DIRS.flatMap(walk).filter((f) => !isWhitelisted(f));

describe("z-index discipline", () => {
	test("no raw `z-[N]` Tailwind classes outside the canonical scale", () => {
		const pattern = /\bz-\[\d+\]/g;
		const violations: string[] = [];
		for (const file of SCAN_FILES) {
			const content = readFileSync(file, "utf8");
			const matches = content.match(pattern);
			if (matches) {
				violations.push(`${relativeNormalized(file)}: ${matches.join(", ")}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("no inline `zIndex: <number>` style literals", () => {
		const pattern = /zIndex\s*:\s*-?\d+/g;
		const violations: string[] = [];
		for (const file of SCAN_FILES) {
			if (!(file.endsWith(".ts") || file.endsWith(".tsx"))) {
				continue;
			}
			const content = readFileSync(file, "utf8");
			const matches = content.match(pattern);
			if (matches) {
				violations.push(`${relativeNormalized(file)}: ${matches.join(", ")}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("no raw `z-index: <number>` CSS outside the canonical declarations", () => {
		// Negative lookbehind for `-` rules out the `--z-index-*` custom property
		// declarations in globals.css; only bare `z-index: 1234` property usage
		// trips this check.
		const pattern = /(?<!-)\bz-index\s*:\s*-?\d+/g;
		const violations: string[] = [];
		for (const file of SCAN_FILES) {
			if (!file.endsWith(".css")) {
				continue;
			}
			const content = readFileSync(file, "utf8");
			const matches = content.match(pattern);
			if (matches) {
				violations.push(`${relativeNormalized(file)}: ${matches.join(", ")}`);
			}
		}
		expect(violations).toEqual([]);
	});
});

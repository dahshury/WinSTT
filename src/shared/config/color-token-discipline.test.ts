import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SCAN_DIRS = [
	join(REPO_ROOT, "src"),
	join(REPO_ROOT, "windows"),
	join(REPO_ROOT, "public"),
];
const ROOT_SCAN_FILES = [join(REPO_ROOT, "index.html")];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".css", ".html"]);
const SKIP_DIRS = new Set([
	"node_modules",
	".next",
	".turbo",
	"dist",
	"build",
	"coverage",
	"playwright-report",
	"provider-icons",
]);
const SKIP_PREFIXES = ["src/features/audio-visualizer/"];
const BRIDGE_FILES = new Set(["src/shared/config/recording-mode-color.ts"]);
const TOKEN_SOURCE_FILES = new Set([
	"src/app/styles/globals.css",
	"public/splash.html",
]);

const TOKEN_DECLARATION_PATTERN =
	/^\s*--(?:color|shadow)-[a-z0-9-]+\s*:[^;\n}]+[;}]/gim;
const COLOR_PATTERNS: Array<[label: string, pattern: RegExp]> = [
	["hex color", /#[0-9a-fA-F]{3,8}\b/g],
	["color function", /\b(?:rgba?|hsla?|oklch)\(/g],
	[
		"palette utility",
		/\b(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-|\/|\b)/g,
	],
	[
		"arbitrary color utility",
		/\b(?:bg|text|border|ring|from|to|via|fill|stroke|shadow)-\[[^\]]*(?:#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\()[^\]]*\]/g,
	],
	[
		"named CSS color",
		/\b(?:background(?:-color)?|border-color|color|box-shadow|text-shadow)\s*:\s*(?:black|white)\b/g,
	],
];

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(entry.name)) {
			continue;
		}
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(path));
		} else if (SCAN_EXTENSIONS.has(extname(entry.name))) {
			out.push(path);
		}
	}
	return out;
}

function relativeNormalized(file: string): string {
	return relative(REPO_ROOT, file).replaceAll("\\", "/");
}

function isTestFile(rel: string): boolean {
	const name = rel.split("/").at(-1) ?? "";
	return name.includes(".test.") || name.includes(".property.test.");
}

function shouldScan(file: string): boolean {
	const rel = relativeNormalized(file);
	return (
		!isTestFile(rel) &&
		!BRIDGE_FILES.has(rel) &&
		!SKIP_PREFIXES.some((prefix) => rel.startsWith(prefix))
	);
}

function blankTokenDeclarations(source: string): string {
	return source.replace(TOKEN_DECLARATION_PATTERN, (match) =>
		match.replace(/[^\r\n]/g, " "),
	);
}

function sourceForScanning(file: string): string {
	const rel = relativeNormalized(file);
	const source = readFileSync(file, "utf8");
	return TOKEN_SOURCE_FILES.has(rel) ? blankTokenDeclarations(source) : source;
}

function lineNumber(source: string, index: number): number {
	return source.slice(0, index).split(/\r?\n/).length;
}

function collectViolations(file: string): string[] {
	const source = sourceForScanning(file);
	const rel = relativeNormalized(file);
	const violations: string[] = [];
	for (const [label, pattern] of COLOR_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of source.matchAll(pattern)) {
			if (match.index === undefined) {
				continue;
			}
			violations.push(
				`${rel}:${lineNumber(source, match.index)} ${label}: ${match[0]}`,
			);
		}
	}
	return violations;
}

const SCAN_FILES = [
	...SCAN_DIRS.filter(existsSync).flatMap(walk),
	...ROOT_SCAN_FILES.filter(existsSync),
].filter(shouldScan);

describe("color token discipline", () => {
	test("application styling uses semantic color tokens instead of hardcoded colors", () => {
		const violations = SCAN_FILES.flatMap(collectViolations);
		expect(violations).toEqual([]);
	});
});

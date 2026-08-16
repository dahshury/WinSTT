import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

/*
 * `text-caption` and `text-title-lg` both shipped as class names with no
 * matching `--text-*` token behind them. Tailwind emits nothing for an
 * undefined utility and the browser reports no error, so the elements simply
 * inherited their parent's font size — invisible in review, invisible at
 * runtime, and only findable by reading globals.css side by side with the JSX.
 *
 * This asserts the other direction: every font-size-shaped `text-*` utility in
 * a class list resolves to a token that actually exists.
 *
 * Scope is .ts/.tsx only. Class lists never appear in CSS here (the repo has no
 * `@apply`), and scanning stylesheets would collide with the `text-transform`
 * CSS property.
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SCAN_DIRS = [join(REPO_ROOT, "src"), join(REPO_ROOT, "windows")];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set([
	"node_modules",
	".next",
	".turbo",
	"dist",
	"build",
	"coverage",
	"playwright-report",
]);

const TOKEN_SOURCE = join(REPO_ROOT, "src/app/styles/globals.css");

/*
 * Tailwind's stock scale stays available: the @theme block extends it rather
 * than resetting it (no `--text-*: initial`).
 */
const BUILTIN_SIZES = [
	"xs",
	"sm",
	"base",
	"lg",
	"xl",
	"2xl",
	"3xl",
	"4xl",
	"5xl",
	"6xl",
	"7xl",
	"8xl",
	"9xl",
];

/* Non-size `text-*` utilities: alignment, wrapping, overflow, special colors. */
const BUILTIN_KEYWORDS = [
	"left",
	"center",
	"right",
	"justify",
	"start",
	"end",
	"wrap",
	"nowrap",
	"balance",
	"pretty",
	"ellipsis",
	"clip",
	"current",
	"inherit",
	"transparent",
];

/*
 * `--text-body--line-height` declares a modifier on the `body` token, not a
 * `body--line-height` token of its own, so the modifier suffix is stripped.
 * Colors share the `text-` prefix and are collected the same way.
 */
const TOKEN_DECLARATION = /--(?:text|color)-([a-z0-9-]+?)(?:--[a-z-]+)?\s*:/gi;

/*
 * A token that could only be a Tailwind utility, never prose. Used to decide
 * whether a string literal is a class list at all — without it, identifiers and
 * copy like "text-to-speech" or a "text-field" test id read as violations.
 */
const UTILITY_TOKEN =
	/^(?:-?(?:m|p)[trblxy]?-|(?:bg|border|rounded|gap|w|h|min-w|min-h|max-w|max-h|grid|col|row|inset|top|left|right|bottom|z|opacity|shadow|ring|font|leading|tracking|truncate|flex|items|justify|self|order|overflow|whitespace|select|cursor|transition|duration|ease|animate|scale|translate|rotate|blur|backdrop|fill|stroke|space|divide|list|object|pointer|touch|will|content|aspect|size|outline|underline|decoration|indent|align|table|antialiased|sr|not-sr|absolute|relative|fixed|sticky|static|block|inline|hidden|contents|isolate|shrink|grow|basis|placeholder|caret|accent|resize|snap|origin|perspective|transform)(?:-|$))/;

const STRING_LITERAL = /"([^"\n]*)"|'([^'\n]*)'|`([^`\n$]*)`/g;

/*
 * Arbitrary values (`text-[13px]`) and CSS-var values (`text-(--x)`) bring their
 * own value and need no token, so the suffix is restricted to a plain utility
 * name. `text-shadow-*` is a separate namespace with its own tokens.
 */
const TEXT_UTILITY =
	/(?<![\w-])text-(?!shadow(?:-|$))([a-z0-9]+(?:-[a-z0-9]+)*)/g;

function declaredTokens(css: string): Set<string> {
	const names = new Set<string>();
	for (const match of css.matchAll(TOKEN_DECLARATION)) {
		names.add(match[1] as string);
	}
	return names;
}

const ALLOWED_SUFFIXES = new Set([
	...declaredTokens(readFileSync(TOKEN_SOURCE, "utf8")),
	...BUILTIN_SIZES,
	...BUILTIN_KEYWORDS,
]);

/** Strips variant prefixes (`hover:`) and opacity modifiers (`/70`). */
function bareToken(token: string): string {
	return token.replace(/^[a-z-]+:/, "").replace(/\/.*$/, "");
}

function looksLikeClassList(value: string): boolean {
	const tokens = value.split(/\s+/).filter(Boolean);
	return (
		tokens.length > 1 &&
		tokens.some((token) => UTILITY_TOKEN.test(bareToken(token)))
	);
}

export function undefinedTextUtilities(source: string): string[] {
	const found: string[] = [];
	for (const literal of source.matchAll(STRING_LITERAL)) {
		const value = literal[1] ?? literal[2] ?? literal[3] ?? "";
		if (!looksLikeClassList(value)) {
			continue;
		}
		for (const match of value.matchAll(TEXT_UTILITY)) {
			const suffix = match[1] as string;
			if (!ALLOWED_SUFFIXES.has(suffix)) {
				found.push(`text-${suffix}`);
			}
		}
	}
	return found;
}

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

function collectViolations(file: string): string[] {
	const source = readFileSync(file, "utf8");
	const rel = relative(REPO_ROOT, file).replaceAll("\\", "/");
	return undefinedTextUtilities(source).map(
		(utility) => `${rel} uses ${utility}, which has no --${utility} token`,
	);
}

/* Test files carry deliberate counter-examples, this suite's own included. */
function isTestFile(file: string): boolean {
	return (file.split(/[\\/]/).at(-1) ?? "").includes(".test.");
}

const SCAN_FILES = SCAN_DIRS.filter(existsSync)
	.flatMap(walk)
	.filter((file) => !isTestFile(file));

describe("text size token discipline", () => {
	test("the token source declares the sizes this suite depends on", () => {
		// A typo'd path or a reshaped @theme block would empty the allow-list and
		// make every assertion below vacuous.
		expect(ALLOWED_SUFFIXES.has("body")).toBe(true);
		expect(ALLOWED_SUFFIXES.has("2xs")).toBe(true);
		expect(ALLOWED_SUFFIXES.has("xs-tight")).toBe(true);
		expect(ALLOWED_SUFFIXES.has("foreground-muted")).toBe(true);
	});

	test("detects a font-size utility with no token behind it", () => {
		// The regression that motivated this file, plus its near neighbours.
		expect(
			undefinedTextUtilities(
				'"flex items-center text-caption text-foreground"',
			),
		).toEqual(["text-caption"]);
		expect(
			undefinedTextUtilities('"font-semibold text-foreground text-title-lg"'),
		).toEqual(["text-title-lg"]);
	});

	test("ignores prose and identifiers that merely start with text-", () => {
		expect(undefinedTextUtilities('"text-to-speech"')).toEqual([]);
		expect(undefinedTextUtilities('data-testid="text-field-row"')).toEqual([]);
		expect(
			undefinedTextUtilities(
				'"flex text-[11px] text-shadow-sm text-foreground/70"',
			),
		).toEqual([]);
	});

	test("every text-* utility in the app resolves to a real token", () => {
		const violations = SCAN_FILES.flatMap(collectViolations);
		expect(violations).toEqual([]);
	});
});

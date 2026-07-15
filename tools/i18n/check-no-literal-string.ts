/**
 * no-literal-string — untranslated JSX text guard.
 *
 * Replaces the old ESLint pass (`eslint src`, whose ONLY job was
 * `i18next/no-literal-string`). Biome has no equivalent rule, so this standalone
 * scanner reproduces it: it flags literal text sitting directly in JSX markup
 * that should have gone through the i18n layer (`t(...)` / `<Trans>`), in a
 * heavily-localized app (20 locales).
 *
 * Scope parity with the retired eslint.config.js:
 *   • checks  src/**\/*.{ts,tsx}
 *   • skips   *.{test,spec}.{ts,tsx}, *test-helpers*, *.d.ts, src/bindings.ts
 *   • mode    JSX-TEXT-ONLY (the plugin's default + the repo's `markupOnly`
 *             intent): only text nodes between JSX tags are checked, not
 *             attributes or arbitrary string literals.
 *   • allowed <Trans>…</Trans> children (the component owns its own i18n).
 *   • skipped strings with no letters (punctuation / digits / arrows / emoji),
 *             all-caps acronyms & hotkey tokens (PTT, LLM, GPU · CPU), and HTML
 *             entities — mirroring the plugin's `words.exclude` defaults.
 *
 * Suppression: honors the SAME comments the codebase already carries, so no
 * source churn was needed when ESLint was removed —
 *   /* eslint-disable i18next/no-literal-string *\/            (file/region)
 *   /* eslint-enable  i18next/no-literal-string *\/            (closes a region)
 *   // eslint-disable-next-line i18next/no-literal-string      (one line)
 * A bare `eslint-disable` / `eslint-disable-next-line` (no rule list) also
 * suppresses, matching ESLint semantics.
 *
 * Usage:
 *   bun tools/i18n/check-no-literal-string.ts            # human report; exit 1 on any hit
 *   bun tools/i18n/check-no-literal-string.ts --json     # machine-readable
 *   bun tools/i18n/check-no-literal-string.ts --quiet    # only print on failure
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, "..", "..", "src");

const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has("--json");
const QUIET = args.has("--quiet");

const SKIP_FILE = /(\.d\.ts$)|(\.(test|spec)\.tsx?$)|(test-helpers)/;
const BINDINGS = path.join(SRC_DIR, "bindings.ts");

interface Violation {
	file: string;
	line: number;
	column: number;
	text: string;
}

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			out.push(...listSourceFiles(full));
		} else if (/\.tsx?$/.test(entry.name)) {
			if (SKIP_FILE.test(full)) continue;
			if (path.resolve(full) === path.resolve(BINDINGS)) continue;
			out.push(full);
		}
	}
	return out;
}

/** True when a string is user-facing text that should be translated. */
function isTranslatable(raw: string): boolean {
	// Strip HTML entities (&nbsp; &mdash; &#8230; …) so they don't read as words.
	const t = raw.replace(/&[a-zA-Z][a-zA-Z0-9]*;|&#\d+;/g, " ").trim();
	if (!t) return false;
	// No letters at all → punctuation / digits / arrows / emoji / separators.
	if (!/\p{L}/u.test(t)) return false;
	// All-caps acronym / hotkey token with no lowercase letter, built only from
	// Latin caps, digits and separators: PTT, LLM, ONNX, "GPU · CPU", "CTRL+V".
	if (!/\p{Ll}/u.test(t) && /^[A-Z0-9 _\-+/.,:;·—–|()[\]]+$/u.test(t)) {
		return false;
	}
	return true;
}

type Comment = { value: string; loc: { start: { line: number } } };

interface AstNode {
	readonly [key: string]: unknown;
	readonly loc?: {
		readonly start: { readonly column: number; readonly line: number };
	} | null;
	readonly type: string;
}

function isAstNode(value: unknown): value is AstNode {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

/** Build the set of line numbers where the rule is suppressed by comments. */
function disabledLines(comments: Comment[], totalLines: number): Set<number> {
	const RULE = "i18next/no-literal-string";
	// A directive targets this rule if it names it explicitly, or is a bare
	// disable (no rule list — only an optional `-- reason`).
	const targets = (body: string, kind: "disable" | "disable-next-line") => {
		const re = new RegExp(`eslint-${kind}\\b([^\\n]*)`);
		const m = body.match(re);
		if (!m) return false;
		const rest = (m[1] ?? "").split("--")[0]?.trim() ?? "";
		return rest === "" || rest.includes(RULE);
	};
	const enables = (body: string) => {
		const m = body.match(/eslint-enable\b([^\n]*)/);
		if (!m) return false;
		const rest = (m[1] ?? "").split("--")[0]?.trim() ?? "";
		return rest === "" || rest.includes(RULE);
	};

	const disabled = new Set<number>();
	let regionOpen: number | null = null;
	const sorted = [...comments].sort(
		(a, b) => a.loc.start.line - b.loc.start.line,
	);
	for (const c of sorted) {
		const line = c.loc.start.line;
		const body = c.value;
		if (targets(body, "disable-next-line")) {
			disabled.add(line + 1);
			continue;
		}
		if (enables(body) && !/eslint-disable/.test(body)) {
			if (regionOpen !== null) {
				for (let l = regionOpen; l <= line; l++) disabled.add(l);
				regionOpen = null;
			}
			continue;
		}
		if (targets(body, "disable")) {
			if (regionOpen === null) regionOpen = line;
		}
	}
	if (regionOpen !== null) {
		for (let l = regionOpen; l <= totalLines; l++) disabled.add(l);
	}
	return disabled;
}

function jsxName(value: unknown): string {
	if (!isAstNode(value)) return "";
	if (value.type === "JSXIdentifier") {
		return typeof value["name"] === "string" ? value["name"] : "";
	}
	if (value.type === "JSXMemberExpression") {
		return `${jsxName(value["object"])}.${jsxName(value["property"])}`;
	}
	if (value.type === "JSXNamespacedName") {
		return `${jsxName(value["namespace"])}:${jsxName(value["name"])}`;
	}
	return "";
}

const SKIP_KEYS = new Set([
	"loc",
	"start",
	"end",
	"range",
	"leadingComments",
	"trailingComments",
	"innerComments",
	"comments",
	"extra",
	"tokens",
]);

function scanFile(file: string, rel: string): Violation[] {
	const code = fs.readFileSync(file, "utf8");
	let ast: ReturnType<typeof parse>;
	try {
		ast = parse(code, {
			sourceType: "module",
			plugins: ["jsx", "typescript", "decorators-legacy"],
			errorRecovery: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`parse failed: ${rel}: ${message}`);
	}
	const totalLines = code.split("\n").length;
	const comments: Comment[] = (ast.comments ?? []).flatMap((comment) =>
		comment.loc
			? [
					{
						value: comment.value,
						loc: { start: { line: comment.loc.start.line } },
					},
				]
			: [],
	);
	const disabled = disabledLines(comments, totalLines);
	const found: Violation[] = [];

	// Manual walk carrying JSX-element ancestry so <Trans> children are exempt.
	const walk = (value: unknown, insideTrans: boolean) => {
		if (!isAstNode(value)) return;
		const node = value;
		if (node.type === "JSXText") {
			if (insideTrans) return;
			const line = node.loc?.start?.line ?? 0;
			if (disabled.has(line)) return;
			const text = node["value"];
			if (typeof text !== "string" || !isTranslatable(text)) return;
			found.push({
				file: rel,
				line,
				column: (node.loc?.start?.column ?? 0) + 1,
				text: text.replace(/\s+/g, " ").trim().slice(0, 80),
			});
			return;
		}
		let nextTrans = insideTrans;
		if (node.type === "JSXElement") {
			const openingElement = node["openingElement"];
			const name = isAstNode(openingElement)
				? jsxName(openingElement["name"])
				: "";
			// `Trans` or any `*.Trans` (e.g. namespaced re-export).
			if (name === "Trans" || name.endsWith(".Trans")) nextTrans = true;
		}
		for (const key of Object.keys(node)) {
			if (SKIP_KEYS.has(key)) continue;
			const val = node[key];
			if (Array.isArray(val)) {
				for (const child of val) walk(child, nextTrans);
			} else {
				walk(val, nextTrans);
			}
		}
	};
	walk(ast.program, false);
	return found;
}

function main() {
	const files = listSourceFiles(SRC_DIR);
	const violations: Violation[] = [];
	const parseErrors: string[] = [];
	for (const file of files) {
		const rel = path
			.relative(path.join(__dirname, "..", ".."), file)
			.replace(/\\/g, "/");
		try {
			violations.push(...scanFile(file, rel));
		} catch (error) {
			parseErrors.push(error instanceof Error ? error.message : String(error));
		}
	}

	if (JSON_OUT) {
		console.log(
			JSON.stringify(
				{ violations, parseErrors, scanned: files.length },
				null,
				2,
			),
		);
		process.exit(violations.length || parseErrors.length ? 1 : 0);
	}

	if (parseErrors.length) {
		console.error(`\n⚠ ${parseErrors.length} file(s) failed to parse:`);
		for (const e of parseErrors) console.error(`  ${e}`);
	}

	if (violations.length === 0) {
		if (!QUIET) {
			console.log(
				`✓ no-literal-string: ${files.length} files clean — no untranslated JSX text.`,
			);
		}
		process.exit(parseErrors.length ? 1 : 0);
	}

	console.error(
		`\n✗ no-literal-string: ${violations.length} untranslated JSX literal(s) in ${
			new Set(violations.map((v) => v.file)).size
		} file(s).\n`,
	);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line}:${v.column}  "${v.text}"`);
	}
	console.error(
		`\nWrap the text in the i18n layer (t(...) / <Trans>), or suppress a` +
			` deliberate case with\n  // eslint-disable-next-line i18next/no-literal-string -- <why>\n`,
	);
	process.exit(1);
}

main();

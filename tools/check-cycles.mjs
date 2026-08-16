#!/usr/bin/env node
/**
 * Circular-dependency gate for the renderer import graph.
 *
 * Why not `madge`: madge parses TS through `detective-typescript`, which bundles
 * `@typescript-eslint/typescript-estree`. That package reads `ts.Extension.Cjs`
 * at module-load time, which is `undefined` under this repo's TypeScript 7 — so
 * madge throws before it parses a single file, with or without `--ts-config`.
 * This checker resolves the same graph with no dependencies, so it cannot drift
 * out of sync with whatever TypeScript version the repo pins.
 *
 * Type-only imports are INCLUDED. They are erased at runtime and so cannot cause
 * a runtime cycle, but every cycle this gate has actually caught was type-only:
 * a module inside a slice importing its own public barrel
 * (`entities/x/lib/y.ts` -> `@/entities/x` -> back to `lib/y.ts`). That is an
 * architecture defect worth failing on, so it counts.
 *
 * Usage: node tools/check-cycles.mjs [rootDir]   (default: src)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";

const ROOT = resolve(process.cwd(), process.argv[2] ?? "src");
const ALIAS_PREFIX = "@/";
const ALIAS_TARGET = resolve(process.cwd(), "src");
const EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx"];
const INDEX_BASENAMES = ["index.ts", "index.tsx", "index.js", "index.jsx"];

/** Collect every source file under `dir`. */
function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			walk(p, out);
		} else if (/\.(tsx?|jsx?)$/.test(name)) {
			out.push(p);
		}
	}
	return out;
}

/**
 * Strip comments and string/template literals so an import-looking token inside
 * a comment or a string can't register as a real edge.
 */
function stripNoise(src) {
	let out = "";
	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		const next = src[i + 1];
		if (c === "/" && next === "/") {
			while (i < n && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && next === "*") {
			i += 2;
			while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			out += c; // keep the opening quote so the import regex can still match
			i++;
			let body = "";
			while (i < n) {
				if (src[i] === "\\") {
					body += src[i] + (src[i + 1] ?? "");
					i += 2;
					continue;
				}
				if (src[i] === quote) break;
				body += src[i];
				i++;
			}
			// Preserve the literal only when it looks like a module specifier;
			// anything else collapses so prose can't create phantom edges.
			out += /^[@./\w-]+$/.test(body) ? body : "";
			out += quote;
			i++;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

const SPECIFIER_RE =
	/(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

function extractSpecifiers(src) {
	const cleaned = stripNoise(src);
	const specs = new Set();
	let m;
	SPECIFIER_RE.lastIndex = 0;
	while ((m = SPECIFIER_RE.exec(cleaned)) !== null) specs.add(m[1]);
	return [...specs];
}

/** Resolve a specifier to a real file path, or null when it leaves the graph. */
function resolveSpecifier(spec, fromFile) {
	let base;
	if (spec.startsWith(ALIAS_PREFIX)) {
		base = join(ALIAS_TARGET, spec.slice(ALIAS_PREFIX.length));
	} else if (spec.startsWith(".")) {
		base = resolve(dirname(fromFile), spec);
	} else {
		return null; // bare package import — not part of our graph
	}

	// Exact file, then extension probes, then directory index.
	const candidates = [base];
	for (const ext of EXTENSIONS) candidates.push(base + ext);
	for (const idx of INDEX_BASENAMES) candidates.push(join(base, idx));

	for (const c of candidates) {
		try {
			if (statSync(c).isFile()) return c;
		} catch {
			// Candidate does not exist — try the next shape.
		}
	}
	return null;
}

const files = walk(ROOT);
/** @type {Map<string, string[]>} */
const graph = new Map();
for (const f of files) {
	const specs = extractSpecifiers(readFileSync(f, "utf8"));
	const edges = [];
	for (const s of specs) {
		const target = resolveSpecifier(s, f);
		if (target && target !== f) edges.push(target);
	}
	graph.set(f, edges);
}

// Iterative DFS with an explicit stack; a back-edge into the current path is a cycle.
const WHITE = 0;
const GREY = 1;
const BLACK = 2;
const color = new Map(files.map((f) => [f, WHITE]));
const cycles = [];
const seenCycles = new Set();

function recordCycle(path, backTo) {
	const start = path.indexOf(backTo);
	if (start === -1) return;
	const cyc = path.slice(start);
	// Canonicalise rotation so the same loop isn't reported once per entry point.
	const rels = cyc.map((p) => relative(process.cwd(), p).split(sep).join("/"));
	let min = 0;
	for (let i = 1; i < rels.length; i++) if (rels[i] < rels[min]) min = i;
	const rotated = [...rels.slice(min), ...rels.slice(0, min)];
	const key = rotated.join(">");
	if (seenCycles.has(key)) return;
	seenCycles.add(key);
	cycles.push(rotated);
}

for (const start of files) {
	if (color.get(start) !== WHITE) continue;
	/** @type {string[]} */
	const path = [];
	/** @type {Array<{node: string, i: number}>} */
	const stack = [{ node: start, i: 0 }];
	color.set(start, GREY);
	path.push(start);

	while (stack.length > 0) {
		const top = stack[stack.length - 1];
		const edges = graph.get(top.node) ?? [];
		if (top.i >= edges.length) {
			color.set(top.node, BLACK);
			stack.pop();
			path.pop();
			continue;
		}
		const nextNode = edges[top.i++];
		const c = color.get(nextNode);
		if (c === GREY) {
			recordCycle(path, nextNode);
		} else if (c === WHITE) {
			color.set(nextNode, GREY);
			path.push(nextNode);
			stack.push({ node: nextNode, i: 0 });
		}
	}
}

const rootLabel = relative(process.cwd(), ROOT).split(sep).join("/") || ".";
if (cycles.length === 0) {
	console.log(
		`check-cycles: ${files.length} files under ${rootLabel} — no circular dependencies.`,
	);
	process.exit(0);
}

console.error(
	`check-cycles: found ${cycles.length} circular dependenc${cycles.length === 1 ? "y" : "ies"} under ${rootLabel}:\n`,
);
cycles.forEach((cyc, n) => {
	console.error(`${n + 1}) ${[...cyc, cyc[0]].join("\n     -> ")}\n`);
});
console.error(
	"A module inside a slice importing its own barrel (@/<layer>/<slice>) is the usual cause;\n" +
		"import from the defining module instead (e.g. ../model/thing-store).",
);
process.exit(1);

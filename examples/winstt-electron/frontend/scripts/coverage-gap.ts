#!/usr/bin/env bun
import { relative, resolve } from "node:path";
import { Glob } from "bun";

const root = resolve(import.meta.dir, "..");
const sourceGlob = new Glob("**/*.{ts,tsx}");
const sourceRoots = ["src", "electron"];

type Bucket = { layer: string; covered: number; total: number; missing: string[] };
const buckets = new Map<string, Bucket>();

function layerOf(path: string): string {
	const parts = path.split(/[\\/]/);
	if (parts[0] === "src") {
		const sub = parts[1] ?? "root";
		return `src/${sub}`;
	}
	if (parts[0] === "electron") {
		const sub = parts[1] ?? "root";
		return `electron/${sub}`;
	}
	return parts[0] ?? "other";
}

const allTestFiles = new Set<string>();
for (const sourceRoot of sourceRoots) {
	for await (const file of sourceGlob.scan({ cwd: resolve(root, sourceRoot), absolute: false })) {
		if (!(file.endsWith(".test.ts") || file.endsWith(".test.tsx"))) continue;
		// A .test.tsx may shadow either a .ts or .tsx source (e.g. testing a hook).
		const base = file.replace(/\.test\.(tsx?)$/, "");
		allTestFiles.add(`${base}.ts`);
		allTestFiles.add(`${base}.tsx`);
	}
}

async function isTrivialReExport(absPath: string): Promise<boolean> {
	const f = Bun.file(absPath);
	if (!(await f.exists())) return false;
	const source = await f.text();
	// Strip comments. Then check the file consists ONLY of re-export
	// statements — they may span multiple lines, so split by `;` and
	// validate each statement against a tolerant re-export regex.
	const stripped = source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "")
		.trim();
	if (stripped.length === 0) return false;
	const statements = stripped
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const REEXPORT_RE =
		/^export\s+(?:type\s+)?(?:\{[\s\S]*?\}|\*(?:\s+as\s+\w+)?)\s+from\s+["'][^"']+["']$/;
	return statements.every((s) => REEXPORT_RE.test(s));
}

for (const sourceRoot of sourceRoots) {
	const cwd = resolve(root, sourceRoot);
	for await (const file of sourceGlob.scan({ cwd, absolute: false })) {
		if (file.endsWith(".test.ts") || file.endsWith(".test.tsx") || file.endsWith(".d.ts")) {
			continue;
		}
		// Treat trivial index.ts re-exports as covered: they have no logic and
		// are statically checked. The components they re-export are tested
		// directly by their own sibling tests.
		const isIndex = file.endsWith("index.ts") || file.endsWith("index.tsx");
		if (isIndex && (await isTrivialReExport(resolve(cwd, file)))) {
			const rel = `${sourceRoot}/${file}`;
			const layer = layerOf(rel);
			const bucket = buckets.get(layer) ?? { layer, covered: 0, total: 0, missing: [] };
			bucket.total += 1;
			bucket.covered += 1;
			buckets.set(layer, bucket);
			continue;
		}
		const rel = `${sourceRoot}/${file}`;
		const layer = layerOf(rel);
		const bucket = buckets.get(layer) ?? { layer, covered: 0, total: 0, missing: [] };
		bucket.total += 1;
		const hasSibling = allTestFiles.has(file);
		if (hasSibling) {
			bucket.covered += 1;
		} else {
			bucket.missing.push(rel);
		}
		buckets.set(layer, bucket);
	}
}

const sorted = Array.from(buckets.values()).toSorted((a, b) => a.layer.localeCompare(b.layer));
const totalCovered = sorted.reduce((s, b) => s + b.covered, 0);
const totalAll = sorted.reduce((s, b) => s + b.total, 0);

const showMissing = process.argv.includes("--missing");

console.log("\nFile-level coverage gap (sibling .test.{ts,tsx} required):\n");
console.log("Layer".padEnd(28), "Covered".padStart(10), "Total".padStart(8), "%".padStart(8));
console.log("-".repeat(56));
for (const b of sorted) {
	const pct = b.total === 0 ? 0 : (100 * b.covered) / b.total;
	console.log(
		b.layer.padEnd(28),
		String(b.covered).padStart(10),
		String(b.total).padStart(8),
		`${pct.toFixed(1)}%`.padStart(8)
	);
}
console.log("-".repeat(56));
const overallPct = totalAll === 0 ? 0 : (100 * totalCovered) / totalAll;
console.log(
	"TOTAL".padEnd(28),
	String(totalCovered).padStart(10),
	String(totalAll).padStart(8),
	`${overallPct.toFixed(1)}%`.padStart(8)
);

if (showMissing) {
	console.log("\nUncovered files:\n");
	for (const b of sorted) {
		if (b.missing.length === 0) continue;
		console.log(`# ${b.layer} (${b.missing.length})`);
		for (const m of b.missing.sort()) console.log(`  ${m}`);
	}
}

const exitCode = process.argv.includes("--strict") && totalCovered < totalAll ? 1 : 0;
process.exit(exitCode);

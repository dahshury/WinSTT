#!/usr/bin/env bun
/**
 * Type-safety debt regression gate.
 *
 * Counts `as unknown as` double-casts AND suppression directives
 * (@ts-ignore / @ts-expect-error / @ts-nocheck / biome-ignore) across the
 * frontend source (electron/, src/, test/, e2e/, packages/) and fails if either
 * total exceeds the committed budget in `cast-budget.json`. A green
 * typecheck/lint says nothing about work suppressed behind a comment.
 *
 * This is a regression FLOOR, in the same spirit as `crap:gate` /
 * `coverage:gate` — it does NOT ban the legitimate contained boundary casts that
 * remain after the 2026-05 type-safety sweep (the i18n locale loader, the
 * per-file mock factories, `asInvalid<T>()`), but it stops NEW scattered
 * `as unknown as` casts from creeping back in. The best-practice alternatives:
 *   - a contained typed mock factory whose return type IS the real type, or a
 *     small `as<Thing>(mock)` helper that holds the single boundary cast, or
 *   - `asInvalid<T>(value)` from `test/lib/cast.ts` for deliberately feeding a
 *     wrong-typed value to a runtime guard.
 *
 * After a deliberate, reviewed change to the count, reseed the budget:
 *   bun scripts/check-cast-budget.ts --update
 */
import { Glob } from "bun";

const ROOTS = ["electron", "src", "test", "e2e", "packages"];
// `as unknown as` double-casts (the strongest escape hatch) …
const CAST = /as unknown as/g;
// … and suppression directives (`@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`,
// `biome-ignore`). Both are budgeted so neither can quietly grow — a green
// typecheck/lint says nothing about work suppressed behind a comment.
const SUPPRESS = /@ts-ignore|@ts-expect-error|@ts-nocheck|biome-ignore/g;
const BUDGET_FILE = new URL("./cast-budget.json", import.meta.url);

type Counts = {
	casts: number;
	suppressions: number;
	perFileCasts: Record<string, number>;
	perFileSuppress: Record<string, number>;
};

async function countDebt(): Promise<Counts> {
	const perFileCasts: Record<string, number> = {};
	const perFileSuppress: Record<string, number> = {};
	let casts = 0;
	let suppressions = 0;
	for (const root of ROOTS) {
		const glob = new Glob(`${root}/**/*.{ts,tsx}`);
		for await (const file of glob.scan(".")) {
			if (file.includes("node_modules") || file.endsWith(".d.ts")) {
				continue;
			}
			const text = await Bun.file(file).text();
			const c = (text.match(CAST) ?? []).length;
			const s = (text.match(SUPPRESS) ?? []).length;
			if (c > 0) {
				perFileCasts[file] = c;
				casts += c;
			}
			if (s > 0) {
				perFileSuppress[file] = s;
				suppressions += s;
			}
		}
	}
	return { casts, suppressions, perFileCasts, perFileSuppress };
}

function report(label: string, perFile: Record<string, number>): void {
	console.error(`  Files with the most ${label}:`);
	for (const [file, count] of Object.entries(perFile)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 15)) {
		console.error(`    ${count}\t${file}`);
	}
}

const { casts, suppressions, perFileCasts, perFileSuppress } = await countDebt();

if (process.argv.includes("--update")) {
	await Bun.write(BUDGET_FILE, `${JSON.stringify({ casts, suppressions }, null, 2)}\n`);
	console.log(`cast-budget reseeded to casts=${casts}, suppressions=${suppressions}`);
	process.exit(0);
}

let budget: { casts: number; suppressions: number };
try {
	budget = await Bun.file(BUDGET_FILE).json();
} catch {
	console.error(
		"cast-budget.json missing — seed with `bun scripts/check-cast-budget.ts --update`."
	);
	process.exit(1);
}

console.log(`as-unknown-as casts: ${casts} (budget ${budget.casts})`);
console.log(`suppression comments: ${suppressions} (budget ${budget.suppressions})`);

let failed = false;
if (casts > budget.casts) {
	console.error(
		`\n✖ Cast budget exceeded by ${casts - budget.casts}. New \`as unknown as\` detected.`
	);
	console.error("  Use a contained typed mock factory or asInvalid<T>() (test/lib/cast.ts).");
	report("casts", perFileCasts);
	failed = true;
}
if (suppressions > budget.suppressions) {
	console.error(
		`\n✖ Suppression budget exceeded by ${suppressions - budget.suppressions}. New @ts-*/biome-ignore detected.`
	);
	console.error("  Fix the underlying type/lint issue instead of suppressing it.");
	report("suppressions", perFileSuppress);
	failed = true;
}
if (failed) {
	process.exit(1);
}
console.log("✔ within budget");

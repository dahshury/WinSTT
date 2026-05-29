#!/usr/bin/env node
/**
 * Colocated-attribution LCOV merge for the sharded local coverage run.
 *
 * THE PROBLEM. Bun's per-process line instrumentation for a given source file
 * is non-deterministic across test processes: the SAME file is instrumented as
 * 76 executable lines in its own focused test but 118 in a big multi-import
 * test (empirically verified — and the divergent lines are instrumented by
 * multiple shards, so no hit-count or shard-count heuristic can separate
 * "phantom" from "real-but-untested"). Any cross-shard SUM/union/max merge is
 * therefore unreliable: it either inflates denominators (well-tested files
 * collapse to 40-72%) or hides genuinely-untested functions.
 *
 * THE FIX. The only reproducible measurement of a unit's coverage is running
 * ITS OWN colocated test in isolation — which is exactly one shard here. So we
 * ATTRIBUTE each source file's coverage to its colocated test shard:
 *   src/x/foo.ts        ← x/foo.test.ts(x)  ∪  x/foo.property.test.ts
 * Colocated tests share a consistent focused line map, so unioning .test +
 * .property.test by per-line MAX hits is safe. A source with no colocated test
 * (barrels, helpers imported elsewhere) falls back to the cleanest single shard
 * (most lines hit, fewest lines found). This both matches isolated per-file
 * ground truth AND honestly surfaces untested functions (a colocated test
 * instruments its whole source, so an untested function shows up at 0 hits).
 *
 * Shards MUST be named by sanitized test path: `<a>__<b>__<stem>.test.ts.info`
 * (path separators → `__`). See crap-coverage-sharded.sh.
 *
 * Usage: node merge-lcov-best.mjs <shard-dir> <out.info>
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function splitRecords(raw) {
	const records = [];
	let cur = null;
	for (const line of raw.split(/\r?\n/)) {
		if (line.startsWith("SF:")) cur = [line];
		else if (cur) {
			cur.push(line);
			if (line === "end_of_record") {
				records.push(cur);
				cur = null;
			}
		}
	}
	return records;
}

const norm = (p) => p.replaceAll("\\", "/").toLowerCase();
const normSF = (record) => norm(record[0].slice(3));
function intAfter(record, prefix) {
	for (const l of record)
		if (l.startsWith(prefix)) return Number.parseInt(l.slice(prefix.length), 10) || 0;
	return 0;
}

/** Shard filename `electron__ipc__llm.test.ts.info` → test path `electron/ipc/llm.test.ts`. */
function shardToTestPath(fname) {
	return norm(fname.replace(/\.info$/, "").replaceAll("__", "/"));
}

/** Source path a test authoritatively covers: strip .test/.property.test, keep dir+stem. */
function authoritativeSource(testPath) {
	// e.g. electron/ipc/llm.test.ts -> electron/ipc/llm   (extension-agnostic stem).
	// Non-greedy stem so `stt-client.property.test.ts` -> `stt-client`, not
	// `stt-client.property` (greedy would swallow the `.property.` marker).
	const m = testPath.match(/^(.*?)\.(?:property\.)?test\.[cm]?[jt]sx?$/);
	return m ? m[1] : null; // dir+stem, no extension
}

/** Does record's SF (a full source path) belong to this dir+stem? */
function sfMatchesStem(sfNorm, stem) {
	const m = sfNorm.match(/^(.*)\.[cm]?[jt]sx?$/);
	return m ? m[1] === stem : false;
}

function parseHits(record) {
	const da = new Map();
	const fnda = new Map();
	for (const l of record) {
		if (l.startsWith("DA:")) {
			const [ln, hits] = l.slice(3).split(",");
			da.set(Number.parseInt(ln, 10), Number.parseInt(hits, 10) || 0);
		} else if (l.startsWith("FNDA:")) {
			const i = l.indexOf(",");
			fnda.set(l.slice(i + 1), Number.parseInt(l.slice(5, i), 10) || 0);
		}
	}
	return { da, fnda };
}

/** Re-emit `base` record with DA/FNDA replaced by maxDa/maxFnda + recomputed LH/FNH. */
function reemit(base, maxDa, maxFnda) {
	const lh = [...maxDa.values()].filter((h) => h > 0).length;
	const fnh = [...maxFnda.values()].filter((h) => h > 0).length;
	const out = [];
	for (const l of base) {
		if (l.startsWith("DA:")) {
			const ln = Number.parseInt(l.slice(3).split(",")[0], 10);
			out.push(`DA:${ln},${maxDa.get(ln) ?? 0}`);
		} else if (l.startsWith("FNDA:")) {
			const name = l.slice(l.indexOf(",") + 1);
			out.push(`FNDA:${maxFnda.get(name) ?? 0},${name}`);
		} else if (l.startsWith("LH:")) out.push(`LH:${lh}`);
		else if (l.startsWith("FNH:")) out.push(`FNH:${fnh}`);
		else out.push(l);
	}
	return out.join("\n");
}

/** Pick the cleanest record (most lines hit, tie-break fewest lines found). */
function pickCanonical(records) {
	let canonical = records[0];
	let bestLh = -1;
	let bestLf = Number.POSITIVE_INFINITY;
	for (const r of records) {
		const lh = intAfter(r, "LH:");
		const lf = intAfter(r, "LF:");
		if (lh > bestLh || (lh === bestLh && lf < bestLf)) {
			canonical = r;
			bestLh = lh;
			bestLf = lf;
		}
	}
	return canonical;
}

/**
 * Attribute coverage for one source file.
 *   mapRecords  — shards that define the LINE MAP (denominator). For a file with
 *                 a colocated test, these are its own *.test shards: a clean,
 *                 non-polluted instrumentation that honestly includes untested
 *                 functions (they appear at 0 hits, so real gaps still surface).
 *   hitRecords  — ALL shards covering this file. We take per-line/per-fn MAX hits
 *                 across them (restricted to the map), so coverage contributed by
 *                 SIBLING test files (e.g. a `_test`-prefixed affordance exercised
 *                 by another suite) is unioned back in.
 * This combines a clean denominator with a complete numerator — matching what the
 * whole test SUITE actually covers, without Bun's per-process line-map pollution.
 */
function attribute(mapRecords, hitRecords) {
	const canonical = pickCanonical(mapRecords);
	const { da: maxDa, fnda: maxFnda } = parseHits(canonical);
	for (const r of hitRecords) {
		if (r === canonical) continue;
		const { da, fnda } = parseHits(r);
		for (const [ln, h] of da) if (maxDa.has(ln) && h > maxDa.get(ln)) maxDa.set(ln, h);
		for (const [n, h] of fnda) if (maxFnda.has(n) && h > maxFnda.get(n)) maxFnda.set(n, h);
	}
	return reemit(canonical, maxDa, maxFnda);
}

function main() {
	const [dir, out] = process.argv.slice(2);
	if (!(dir && out)) {
		console.error("usage: merge-lcov-best.mjs <shard-dir> <out.info>");
		process.exit(2);
	}
	const shardNames = readdirSync(dir).filter((f) => f.endsWith(".info"));

	// Collect: per source SF, list of {record, testStem|null}.
	// And: per source SF, list of records from its colocated test shards.
	const colocated = new Map(); // sfNorm -> records[]
	const allBySf = new Map(); // sfNorm -> records[]  (fallback pool)

	for (const fname of shardNames) {
		const testPath = shardToTestPath(fname);
		const stem = authoritativeSource(testPath); // dir+stem this shard "owns", or null
		for (const record of splitRecords(readFileSync(join(dir, fname), "utf8"))) {
			const sf = normSF(record);
			if (!allBySf.has(sf)) allBySf.set(sf, []);
			allBySf.get(sf).push(record);
			if (stem && sfMatchesStem(sf, stem)) {
				if (!colocated.has(sf)) colocated.set(sf, []);
				colocated.get(sf).push(record);
			}
		}
	}

	const outRecords = [];
	let attributed = 0;
	let fellBack = 0;
	for (const [sf, records] of allBySf) {
		const own = colocated.get(sf);
		if (own && own.length > 0) {
			// Clean map from the colocated test; hits unioned across ALL shards.
			outRecords.push(attribute(own, records));
			attributed++;
		} else {
			// Orphan (barrel/helper): cleanest available shard defines the map.
			outRecords.push(attribute(records, records));
			fellBack++;
		}
	}

	writeFileSync(out, `${outRecords.join("\n")}\n`);
	console.error(
		`merge: ${shardNames.length} shards → ${allBySf.size} files (${attributed} colocated-attributed, ${fellBack} fallback) → ${out}`
	);
}

main();

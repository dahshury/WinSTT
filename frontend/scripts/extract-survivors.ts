#!/usr/bin/env bun
/**
 * Extract surviving mutants from a Stryker HTML report.
 *
 * The HTML embeds the full report as JSON inside one of the inline `<script>`
 * blocks. The mutant entries can be enormous (statusReason includes full test
 * output), so a single regex with `[\s\S]*?` to span fields is unreliable.
 *
 * Strategy: find each `{"id":"..."` boundary, walk forward with a brace
 * counter to extract the full JSON object, parse it, and pick the survived ones.
 */
export {};

const html = await Bun.file("reports/mutation/mutation.html").text();

// Walk through every `{"id":"...","mutatorName":` start.
const startRe = /\{"id":"[^"]+","mutatorName":"/g;
const startPositions: number[] = [];
for (let m = startRe.exec(html); m !== null; m = startRe.exec(html)) {
	startPositions.push(m.index);
}

interface Mutant {
	id: string;
	location?: { start: { line: number; column: number } };
	mutatorName: string;
	status?: string;
}

function readMutant(start: number): { obj: Mutant; end: number } | null {
	if (html[start] !== "{") return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	let i = start;
	for (; i < html.length; i++) {
		const ch = html[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
		} else {
			if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					const slice = html.slice(start, i + 1);
					try {
						return { obj: JSON.parse(slice) as Mutant, end: i + 1 };
					} catch {
						return null;
					}
				}
			}
		}
	}
	return null;
}

// Find file path positions: `"<...>.ts":{"language":` markers anchor each file.
const pathRe = /"((?:src|electron)\/[^"]+\.ts)":\{"language":/g;
const filePositions: Array<{ path: string; index: number }> = [];
for (let p = pathRe.exec(html); p !== null; p = pathRe.exec(html)) {
	filePositions.push({ path: p[1] as string, index: p.index });
}

function fileFor(idx: number): string {
	let last = "?";
	for (const f of filePositions) {
		if (f.index < idx) last = f.path;
		else break;
	}
	return last;
}

const sources: Record<string, string[]> = {};
async function getSourceLine(path: string, line: number): Promise<string> {
	if (!sources[path]) {
		const f = Bun.file(path);
		if (!(await f.exists())) return "<file not found>";
		sources[path] = (await f.text()).split("\n");
	}
	return sources[path][line - 1] || "";
}

const grouped = new Map<string, Array<{ mutant: Mutant; idx: number }>>();
for (const startIdx of startPositions) {
	const parsed = readMutant(startIdx);
	if (!parsed) continue;
	if (parsed.obj.status !== "Survived") continue;
	const path = fileFor(startIdx);
	const list = grouped.get(path) ?? [];
	list.push({ mutant: parsed.obj, idx: startIdx });
	grouped.set(path, list);
}

let total = 0;
for (const [path, list] of grouped) {
	console.log(`\n## ${path}  (${list.length})`);
	for (const { mutant } of list) {
		const startLine = mutant.location?.start.line ?? 0;
		const src = (await getSourceLine(path, startLine)).trim();
		console.log(`  L${startLine}  [${mutant.mutatorName}]`);
		console.log(`    ${src.slice(0, 130)}`);
		total++;
	}
}
console.log(`\n# Total survivors: ${total}`);

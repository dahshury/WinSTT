import fs from "node:fs";

interface CrapEntry {
	complexity: number;
	coverage: number;
	crap: number;
	file: string;
	name: string;
	startLine: number;
}

const data = JSON.parse(fs.readFileSync("reports/crap.json", "utf8")) as CrapEntry[];
const wip = new Set(
	fs
		.readFileSync("scripts/wip.txt", "utf8")
		.split("\n")
		.filter(Boolean)
		.map((p) => p.replace(/^frontend\//, ""))
);

const targets = data
	.filter(
		(x) =>
			x.crap > 5 &&
			!wip.has(x.file) &&
			!x.file.includes(".test.") &&
			!x.file.includes("test-helpers")
	)
	.sort((a, b) => b.crap - a.crap)
	.slice(0, 25);

console.log(`Found ${targets.length} non-WIP high-CRAP targets:`);
for (const e of targets) {
	console.log(
		`  crap=${e.crap.toFixed(0).padStart(4)}  cov=${(e.coverage * 100).toFixed(0).padStart(3)}%  cx=${e.complexity}  ${e.file}::${e.name} (L${e.startLine})`
	);
}

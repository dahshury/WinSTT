import { argv } from "node:process";

const path = argv[2] ?? "reports/crap-tmp.json";
const needle = argv[3] ?? "features/push-to-talk/api/use-push-to-talk.ts";
const d = JSON.parse(await Bun.file(path).text()) as Array<{
	file: string;
	name: string;
	complexity: number;
	coverage: number;
	crap: number;
	startLine: number;
	endLine: number;
}>;
const filtered = d.filter((m) => m.file && m.file.replaceAll("\\", "/").endsWith(needle));
for (const m of filtered) {
	console.log(
		`${m.name.padEnd(40)} CC=${m.complexity} cov=${m.coverage} crap=${m.crap} L${m.startLine}-${m.endLine}`
	);
}
const sum = filtered.reduce((acc, m) => acc + (m.crap ?? 0), 0);
const max = filtered.reduce((acc, m) => Math.max(acc, m.complexity ?? 0), 0);
const over = filtered.filter((m) => (m.crap ?? 0) >= 4);
console.log(
	`\ncount=${filtered.length} sumCRAP=${sum.toFixed(2)} maxCC=${max} over4=${over.length}`
);
console.log("OVER 4:", over.map((m) => `${m.name}(crap=${m.crap})`).join(", "));

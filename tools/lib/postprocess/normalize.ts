// TS mirror of the Rust runtime normalizer `explode_inline_lists`
// (src-tauri/src/winstt/llm/normalize.rs). Applied so evaluation sees what the
// app actually pastes after layout normalization. Keep the two in sync — this
// is the single copy shared by the regression tool and the modifier benchmark.

export function explodeInlineLists(text: string): string {
	return text.split("\n").map(explodeLine).join("\n");
}

function explodeLine(line: string): string {
	return explodeNumbered(line) ?? explodeBulleted(line) ?? line;
}

function explodeNumbered(line: string): string | null {
	const markers: Array<{ start: number; contentStart: number; num: number }> =
		[];
	const re = /(\d{1,3})[.)]\s+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(line)) !== null) {
		markers.push({
			start: m.index,
			contentStart: m.index + m[0].length,
			num: Number(m[1]),
		});
	}
	const run: typeof markers = [];
	for (const mk of markers) {
		if (mk.num === run.length + 1) run.push(mk);
		else if (mk.num === 1) run.splice(0, run.length, mk);
	}
	if (run.length < 2) return null;
	const leadIn = line.slice(0, run[0]!.start).replace(/\s+$/, "");
	const parts: string[] = [];
	if (leadIn) parts.push(leadIn + (leadIn.endsWith(":") ? "\n" : ""));
	run.forEach((mk, idx) => {
		const end = idx + 1 < run.length ? run[idx + 1]!.start : line.length;
		parts.push(`${mk.num}. ${line.slice(mk.contentStart, end).trim()}`);
	});
	return parts.join("\n");
}

function explodeBulleted(line: string): string | null {
	const starts: number[] = [];
	for (let i = 0; i + 1 < line.length; i++) {
		const isMarker =
			(line[i] === "*" || line[i] === "-") && line[i + 1] === " ";
		const atBoundary = i === 0 || line[i - 1] === " ";
		if (isMarker && atBoundary) {
			starts.push(i);
			i += 1;
		}
	}
	if (starts.length < 2) return null;
	const leadIn = line.slice(0, starts[0]).replace(/\s+$/, "");
	const parts: string[] = [];
	if (leadIn) parts.push(leadIn + (leadIn.endsWith(":") ? "\n" : ""));
	starts.forEach((start, idx) => {
		const end = idx + 1 < starts.length ? starts[idx + 1]! : line.length;
		parts.push(`* ${line.slice(start + 2, end).trim()}`);
	});
	return parts.join("\n");
}

export function normalize(text: string): string {
	return explodeInlineLists(text.replace(/\r\n/g, "\n"))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

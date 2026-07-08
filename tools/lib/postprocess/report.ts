import type { BenchmarkReport, ModifierModelAgg } from "./types";

// Self-contained HTML report with hand-rolled inline SVG charts (no chart lib,
// matching the app's bespoke-SVG convention). The palette is neutral: model
// series use categorical hues and the heatmap is monochrome intensity — value
// is never encoded as green=good / red=bad.

const SERIES = [
	"#6366f1",
	"#f59e0b",
	"#ec4899",
	"#22d3ee",
	"#a78bfa",
	"#f472b6",
];

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function seriesColor(i: number): string {
	return SERIES[i % SERIES.length]!;
}

function aggMap(report: BenchmarkReport): Map<string, ModifierModelAgg> {
	const m = new Map<string, ModifierModelAgg>();
	for (const a of report.aggregates) m.set(`${a.modifierId} ${a.model}`, a);
	return m;
}

function legend(models: string[]): string {
	return `<div class="legend">${models
		.map(
			(model, i) =>
				`<span class="lg"><i style="background:${seriesColor(i)}"></i>${esc(model)}</span>`,
		)
		.join("")}</div>`;
}

// ── composite heatmap ───────────────────────────────────────────────────────

function heatmap(report: BenchmarkReport): string {
	const { modifiers, models } = report;
	const map = aggMap(report);
	const cellW = 108;
	const cellH = 30;
	const labelW = 150;
	const headerH = 28;
	const width = labelW + models.length * cellW + 16;
	const height = headerH + modifiers.length * cellH + 8;
	const parts: string[] = [];
	models.forEach((model, i) => {
		const x = labelW + i * cellW + cellW / 2;
		parts.push(
			`<text x="${x}" y="18" class="hcol">${esc(shortModel(model))}</text>`,
		);
	});
	modifiers.forEach((modifier, r) => {
		const y = headerH + r * cellH;
		parts.push(
			`<text x="${labelW - 8}" y="${y + cellH / 2 + 4}" class="hrow">${esc(modifier)}</text>`,
		);
		models.forEach((model, c) => {
			const x = labelW + c * cellW;
			const agg = map.get(`${modifier} ${model}`);
			const v = agg ? agg.composite : null;
			const light = v === null ? 12 : 18 + (v / 100) * 52;
			const fill = v === null ? "#1a1d24" : `hsl(222 45% ${light}%)`;
			const text = v === null ? "·" : v.toFixed(0);
			const tc = v !== null && light > 45 ? "#0b0d12" : "#e7e9ee";
			parts.push(
				`<rect x="${x + 2}" y="${y + 2}" width="${cellW - 4}" height="${cellH - 4}" rx="4" fill="${fill}"/>` +
					`<text x="${x + cellW / 2}" y="${y + cellH / 2 + 4}" class="hval" fill="${tc}">${text}</text>`,
			);
		});
	});
	return svg(width, height, parts.join(""));
}

function shortModel(model: string): string {
	return model.length > 18 ? `${model.slice(0, 17)}…` : model;
}

// ── grouped bar chart (one metric, models as series) ────────────────────────

function groupedBars(
	report: BenchmarkReport,
	pick: (a: ModifierModelAgg) => number | null,
	opts: { max: number; unit: string },
): string {
	const { modifiers, models } = report;
	const map = aggMap(report);
	const padL = 44;
	const padB = 78;
	const padT = 12;
	const groupW = Math.max(70, models.length * 20 + 24);
	const width = padL + modifiers.length * groupW + 16;
	const height = 240;
	const plotH = height - padB - padT;
	const parts: string[] = [];
	// y gridlines
	for (let g = 0; g <= 4; g++) {
		const v = (opts.max / 4) * g;
		const y = padT + plotH - (v / opts.max) * plotH;
		parts.push(
			`<line x1="${padL}" y1="${y}" x2="${width - 8}" y2="${y}" class="grid"/>` +
				`<text x="${padL - 6}" y="${y + 3}" class="ytick">${v.toFixed(0)}</text>`,
		);
	}
	const barW = (groupW - 20) / models.length;
	modifiers.forEach((modifier, gi) => {
		const gx = padL + gi * groupW + 10;
		parts.push(
			`<text x="${gx + (groupW - 20) / 2}" y="${height - padB + 14}" class="xtick" transform="rotate(35 ${gx + (groupW - 20) / 2} ${height - padB + 14})">${esc(modifier)}</text>`,
		);
		models.forEach((model, mi) => {
			const agg = map.get(`${modifier} ${model}`);
			const v = agg ? pick(agg) : null;
			if (v === null || v === undefined) return;
			const h = Math.max(1, (v / opts.max) * plotH);
			const x = gx + mi * barW;
			const y = padT + plotH - h;
			parts.push(
				`<rect x="${x}" y="${y}" width="${barW - 2}" height="${h}" rx="2" fill="${seriesColor(mi)}"><title>${esc(modifier)} · ${esc(model)}: ${v.toFixed(1)}${opts.unit}</title></rect>`,
			);
		});
	});
	return svg(width, height, parts.join(""));
}

// ── magnitude scatter (surface vs semantic delta) ───────────────────────────

function scatter(report: BenchmarkReport): string {
	const { models } = report;
	const pts = report.aggregates.filter((a) => a.meanSemanticDelta !== null);
	if (pts.length === 0) {
		return `<p class="note">Semantic delta unavailable (embeddings disabled or the embed model returned no vectors), so the 2-D magnitude scatter is omitted. Surface delta is still shown in the table.</p>`;
	}
	const padL = 46;
	const padB = 40;
	const padT = 12;
	const width = 660;
	const height = 380;
	const plotW = width - padL - 16;
	const plotH = height - padB - padT;
	const maxY =
		Math.max(0.3, ...pts.map((p) => p.meanSemanticDelta ?? 0)) * 1.15;
	const xT = 0.15; // surface no-op threshold
	const yT = 0.12; // semantic drift threshold
	const sx = (v: number) => padL + Math.min(1, v) * plotW;
	const sy = (v: number) => padT + plotH - (v / maxY) * plotH;
	const parts: string[] = [];
	// quadrant guides
	parts.push(
		`<line x1="${sx(xT)}" y1="${padT}" x2="${sx(xT)}" y2="${padT + plotH}" class="qline"/>`,
		`<line x1="${padL}" y1="${sy(yT)}" x2="${padL + plotW}" y2="${sy(yT)}" class="qline"/>`,
		`<text x="${sx(xT) + 6}" y="${padT + 12}" class="qlabel">clean restyle →</text>`,
		`<text x="${sx(xT) + 6}" y="${sy(yT) - 6}" class="qlabel">meaning drift ↑</text>`,
		`<text x="${padL + 4}" y="${padT + plotH - 4}" class="qlabel">← no-op</text>`,
	);
	// axes
	for (let g = 0; g <= 5; g++) {
		const v = (g / 5) * 1;
		parts.push(
			`<text x="${sx(v)}" y="${height - padB + 16}" class="xtick2">${v.toFixed(1)}</text>`,
		);
	}
	for (let g = 0; g <= 4; g++) {
		const v = (maxY / 4) * g;
		parts.push(
			`<text x="${padL - 6}" y="${sy(v) + 3}" class="ytick">${v.toFixed(2)}</text>`,
		);
	}
	parts.push(
		`<text x="${padL + plotW / 2}" y="${height - 6}" class="axis">surface Δ (wording changed)</text>`,
		`<text transform="translate(12 ${padT + plotH / 2}) rotate(-90)" class="axis">semantic Δ (meaning moved)</text>`,
	);
	for (const p of pts) {
		const mi = models.indexOf(p.model);
		parts.push(
			`<circle cx="${sx(p.meanSurfaceDelta)}" cy="${sy(p.meanSemanticDelta ?? 0)}" r="5" fill="${seriesColor(mi)}" fill-opacity="0.85" stroke="#0b0d12" stroke-width="0.5"><title>${esc(p.modifierId)} · ${esc(p.model)}\nΔs ${p.meanSurfaceDelta.toFixed(2)} Δm ${(p.meanSemanticDelta ?? 0).toFixed(2)} · ${esc(dominantMagnitude(p))}</title></circle>`,
		);
	}
	return svg(width, height, parts.join(""));
}

function dominantMagnitude(a: ModifierModelAgg): string {
	let best = "—";
	let bestN = -1;
	for (const [k, n] of Object.entries(a.magnitudeCounts))
		if (n > bestN) {
			bestN = n;
			best = k;
		}
	return best;
}

// ── table ───────────────────────────────────────────────────────────────────

function table(report: BenchmarkReport): string {
	const rows = report.aggregates
		.map((a) => {
			const cells = [
				esc(a.modifierId),
				esc(a.model),
				a.composite.toFixed(0),
				a.style === null ? "—" : a.style.toFixed(0),
				a.accuracy.toFixed(0),
				`${(a.guardPassRate * 100).toFixed(0)}%`,
				a.adherence === null ? "—" : `${(a.adherence * 100).toFixed(0)}%`,
				a.meanSurfaceDelta.toFixed(2),
				a.meanSemanticDelta === null ? "—" : a.meanSemanticDelta.toFixed(2),
				a.medianTokensPerSec === null ? "—" : a.medianTokensPerSec.toFixed(0),
				a.medianWallMs.toFixed(0),
				esc(dominantMagnitude(a)),
			];
			return `<tr>${cells.map((c, i) => `<td class="${i < 2 ? "l" : "r"}">${c}</td>`).join("")}</tr>`;
		})
		.join("");
	const head = [
		"modifier",
		"model",
		"comp",
		"style",
		"acc",
		"guard",
		"adhere",
		"Δs",
		"Δm",
		"tok/s",
		"ms",
		"verdict",
	]
		.map((h, i) => `<th class="${i < 2 ? "l" : "r"}">${h}</th>`)
		.join("");
	return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function svg(w: number, h: number, body: string): string {
	return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px" xmlns="http://www.w3.org/2000/svg" font-family="var(--mono)">${body}</svg>`;
}

export function renderHtmlReport(report: BenchmarkReport): string {
	const judge = report.judgeModel
		? `${report.judgeProvider} / ${esc(report.judgeModel)}`
		: "disabled";
	const selfJudge =
		report.judgeModel && report.models.includes(report.judgeModel);
	return `<div class="wrap">
<h1>LLM modifier benchmark</h1>
<p class="meta">Generated ${esc(report.generatedAt)} · runner <b>${esc(report.runnerProvider)}</b> · judge <b>${esc(judge)}</b> · embed <b>${esc(report.embedModel ?? "off")}</b> · ${report.samples.corpus} corpus + ${report.samples.capability} capability samples · ${report.trialsPerCell} trial(s)/cell</p>
${selfJudge ? `<p class="warn">⚠ The judge model is also under test — self-preference bias inflates its own scores. Use a stronger, independent judge (cloud) for calibrated numbers.</p>` : ""}

<h2>Composite quality — model × modifier</h2>
<p class="cap">Blend of judge style (0.5) + accuracy (0.5), scaled by guard pass-rate. Darker = higher. Value is intensity only, not a green/red judgement.</p>
${heatmap(report)}

<h2>Style — tone/register achievement (LLM judge)</h2>
<p class="cap">Mean judge <code>style_match</code>: how fully each model achieves the requested transformation.</p>
${legend(report.models)}
${groupedBars(report, (a) => a.style, { max: 100, unit: "" })}

<h2>Accuracy — meaning preserved + instructions followed</h2>
<p class="cap">Blend of judge meaning-preservation &amp; fidelity with deterministic capability-check pass-rate.</p>
${legend(report.models)}
${groupedBars(report, (a) => a.accuracy, { max: 100, unit: "" })}

<h2>Speed — throughput per modifier (from run data)</h2>
<p class="cap">Median generation throughput (tokens/sec). Deterministic, measured from actual run timing.</p>
${legend(report.models)}
${groupedBars(report, (a) => a.medianTokensPerSec, { max: maxOf(report, (a) => a.medianTokensPerSec), unit: " tok/s" })}

<h2>Magnitude — how much the text changed</h2>
<p class="cap">Each point is a model×modifier mean. High surface Δ with low semantic Δ = clean restyle (good). Low both = no-op (model ignored the modifier). High semantic Δ = meaning drift.</p>
${legend(report.models)}
${scatter(report)}

<h2>All numbers</h2>
${table(report)}
</div>
${STYLE}`;
}

function maxOf(
	report: BenchmarkReport,
	pick: (a: ModifierModelAgg) => number | null,
): number {
	const vals = report.aggregates
		.map(pick)
		.filter((v): v is number => v !== null && v > 0);
	return vals.length ? Math.max(...vals) * 1.1 : 1;
}

const STYLE = `<style>
:root{--mono:ui-monospace,"Cascadia Code",Menlo,Consolas,monospace}
html,body{background:#0f1115;margin:0}
.wrap{max-width:940px;margin:0 auto;padding:8px 16px 64px;background:#0f1115;color:#e7e9ee;font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;min-height:100vh}
h1{font-size:22px;margin:12px 0 4px}
h2{font-size:15px;margin:34px 0 4px;padding-top:10px;border-top:1px solid #262a33}
.meta{color:#9aa2b1;font-size:12.5px;margin:4px 0 8px}
.warn{background:#2a2320;border:1px solid #4a3a2a;color:#f0c07a;padding:8px 12px;border-radius:8px;font-size:12.5px}
.cap{color:#9aa2b1;font-size:12.5px;margin:2px 0 10px}
.cap code,code{background:#20242c;padding:1px 5px;border-radius:4px;font-family:var(--mono);font-size:11.5px}
.note{color:#9aa2b1;font-size:12.5px;font-style:italic}
.legend{display:flex;flex-wrap:wrap;gap:12px;margin:2px 0 8px}
.lg{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#c3c9d4;font-family:var(--mono)}
.lg i{width:11px;height:11px;border-radius:3px;display:inline-block}
svg{overflow:visible}
.grid{stroke:#262a33;stroke-width:1}
.qline{stroke:#3a4150;stroke-width:1;stroke-dasharray:4 4}
.qlabel{fill:#7b8494;font-size:10px}
.ytick,.xtick2{fill:#7b8494;font-size:10px}
.ytick{text-anchor:end}.xtick2{text-anchor:middle}
.xtick{fill:#c3c9d4;font-size:10.5px;text-anchor:start}
.axis{fill:#9aa2b1;font-size:11px;text-anchor:middle}
.hcol{fill:#c3c9d4;font-size:11px;text-anchor:middle}
.hrow{fill:#c3c9d4;font-size:11.5px;text-anchor:end}
.hval{font-size:11.5px;text-anchor:middle;font-family:var(--mono)}
table{border-collapse:collapse;width:100%;font-family:var(--mono);font-size:11.5px;margin-top:6px}
th,td{padding:4px 8px;border-bottom:1px solid #23272f}
th{color:#9aa2b1;font-weight:600;position:sticky;top:0;background:#14171d}
td.r,th.r{text-align:right}td.l,th.l{text-align:left}
tbody tr:hover{background:#181c23}
</style>`;

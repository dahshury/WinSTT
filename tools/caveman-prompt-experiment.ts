import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildSystemPrompt } from "../src/shared/lib/preset-prompts";
import {
	callOllamaChat,
	embedOllama,
	extractText,
	ollamaConfig,
	TEXT_SCHEMA,
} from "./lib/postprocess/clients";
import {
	buildCavemanSystemPrompt,
	buildCavemanUserPrompt,
} from "./lib/postprocess/caveman-prompts";
import {
	BENCHMARK_CORPUS,
	CAPABILITY_GAP_CASES,
	CAPABILITY_GAP_PROFILES,
	type CapabilityCheck,
} from "./lib/postprocess/corpus";
import {
	buildJudgeUser,
	JUDGE_SCHEMA,
	JUDGE_SYSTEM,
	parseJudge,
	type JudgeScores,
} from "./lib/postprocess/judge";
import {
	magnitudeVerdict,
	runGuards,
	semanticDelta,
	surfaceDelta,
} from "./lib/postprocess/metrics";
import { normalize } from "./lib/postprocess/normalize";
import { buildUserPromptForPresets } from "./lib/postprocess/prompts";

type Variant = "current" | "caveman-ultra";

interface Sample {
	id: string;
	kind: "corpus" | "capability";
	before: string;
	reference?: string;
	checks?: readonly CapabilityCheck[];
	appliesTo: readonly string[];
}

interface RecordRow {
	variant: Variant;
	modifierId: string;
	sampleId: string;
	sampleKind: Sample["kind"];
	trial: number;
	systemChars: number;
	userChars: number;
	output: string;
	promptTokens: number | null;
	promptMs: number | null;
	genTokens: number | null;
	genMs: number | null;
	wallMs: number;
	surfaceDelta: number;
	semanticDelta: number | null;
	magnitude: string;
	guardPass: boolean;
	guardResults: ReturnType<typeof runGuards>["results"];
	capabilityPass: number | null;
	judge: JudgeScores | null;
	error: string | null;
}

interface Aggregate {
	variant: Variant;
	modifierId: string;
	runs: number;
	errors: number;
	promptChars: number;
	promptTokens: number;
	promptMs: number;
	genTokens: number;
	genMs: number;
	modelMs: number;
	wallMs: number;
	guardPassRate: number;
	capability: number | null;
	style: number | null;
	accuracy: number;
	composite: number;
}

function flag(name: string): string | undefined {
	const prefix = `--${name}=`;
	return process.argv
		.find((arg) => arg.startsWith(prefix))
		?.slice(prefix.length);
}

function has(name: string): boolean {
	return process.argv.includes(`--${name}`);
}

function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

const MODEL = flag("model") ?? process.env["OLLAMA_MODEL"] ?? "gemma4:e4b";
const TRIALS = Math.max(1, Number(flag("trials") ?? 1));
const CORPUS_LIMIT = Math.max(0, Number(flag("corpus-limit") ?? 3));
const JUDGE_ENABLED = !has("no-judge");
const EMBED_ENABLED = !has("no-embed");
const CAPABILITY_ENABLED = !has("no-capability");
const TARGETED_CAPABILITY = has("targeted-capability");
const OUT =
	flag("out") ?? join(import.meta.dir, "out", "caveman-prompt-experiment.json");
const REPORT =
	flag("report") ??
	join(
		import.meta.dir,
		"..",
		"docs",
		"research",
		"caveman-prompt-experiment.md",
	);
const SELECTED = (() => {
	const requested = list(flag("modifiers"));
	if (requested.length === 0 || requested.includes("all")) {
		return CAPABILITY_GAP_PROFILES;
	}
	const ids = new Set(requested);
	return CAPABILITY_GAP_PROFILES.filter((profile) => ids.has(profile.id));
})();

function samples(): Sample[] {
	return [
		...BENCHMARK_CORPUS.slice(0, CORPUS_LIMIT).map((item) => ({
			id: item.id,
			kind: "corpus" as const,
			before: item.before,
			reference: item.after,
			appliesTo: [] as string[],
		})),
		...(CAPABILITY_ENABLED
			? CAPABILITY_GAP_CASES.map((item) => ({
					id: item.id,
					kind: "capability" as const,
					before: item.before,
					checks: item.checks,
					appliesTo: item.profiles ?? [],
				}))
			: []),
	];
}

function sampleApplies(sample: Sample, modifierId: string): boolean {
	if (sample.kind === "corpus") return true;
	if (sample.appliesTo.length > 0) return sample.appliesTo.includes(modifierId);
	return !TARGETED_CAPABILITY || modifierId === "neutral";
}

function mean(values: number[]): number {
	return values.length === 0
		? 0
		: values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

function numbers(
	rows: RecordRow[],
	read: (row: RecordRow) => number | null,
): number[] {
	return rows.map(read).filter((value): value is number => value !== null);
}

function accuracy(row: RecordRow): number | null {
	const parts: number[] = [];
	if (row.judge) {
		parts.push(row.judge.meaningPreservation, row.judge.fidelity);
	}
	if (row.capabilityPass !== null) parts.push(row.capabilityPass * 100);
	if (parts.length > 0) return mean(parts);
	if (row.semanticDelta !== null && row.modifierId !== "translate") {
		return Math.max(0, Math.min(100, (1 - row.semanticDelta) * 100));
	}
	return null;
}

function aggregate(rows: RecordRow[]): Aggregate[] {
	const groups = new Map<string, RecordRow[]>();
	for (const row of rows) {
		const key = `${row.variant}\u0000${row.modifierId}`;
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
	}
	return [...groups.entries()]
		.map(([key, group]) => {
			const [variant, modifierId] = key.split("\u0000") as [Variant, string];
			const ok = group.filter((row) => row.error === null);
			const styles = numbers(ok, (row) => row.judge?.styleMatch ?? null);
			const accuracies = numbers(ok, accuracy);
			const capabilities = numbers(ok, (row) => row.capabilityPass);
			const guardPassRate = mean(ok.map((row) => (row.guardPass ? 1 : 0)));
			const style = styles.length > 0 ? mean(styles) : null;
			const accuracyScore = mean(accuracies);
			const raw = style === null ? accuracyScore : (style + accuracyScore) / 2;
			return {
				variant,
				modifierId,
				runs: group.length,
				errors: group.length - ok.length,
				promptChars: median(ok.map((row) => row.systemChars + row.userChars)),
				promptTokens: median(numbers(ok, (row) => row.promptTokens)),
				promptMs: median(numbers(ok, (row) => row.promptMs)),
				genTokens: median(numbers(ok, (row) => row.genTokens)),
				genMs: median(numbers(ok, (row) => row.genMs)),
				modelMs: median(
					numbers(ok, (row) =>
						row.promptMs !== null && row.genMs !== null
							? row.promptMs + row.genMs
							: null,
					),
				),
				wallMs: median(ok.map((row) => row.wallMs)),
				guardPassRate,
				capability: capabilities.length > 0 ? mean(capabilities) : null,
				style,
				accuracy: accuracyScore,
				composite: raw * (0.5 + 0.5 * guardPassRate),
			};
		})
		.sort(
			(a, b) =>
				a.modifierId.localeCompare(b.modifierId) ||
				a.variant.localeCompare(b.variant),
		);
}

async function judge(
	modifierId: string,
	sample: Sample,
	output: string,
	label: string,
): Promise<JudgeScores | null> {
	if (!JUDGE_ENABLED) return null;
	const response = await callOllamaChat({
		model: MODEL,
		system: JUDGE_SYSTEM,
		user: buildJudgeUser({
			modifierId,
			before: sample.before,
			after: output,
			reference: sample.reference,
		}),
		format: JUDGE_SCHEMA,
		numPredict: 1024,
		timeoutMs: 60_000,
		label: `${label}:judge`,
	});
	return parseJudge(response.raw);
}

const embeddingCache = new Map<string, number[] | null>();
async function embedding(text: string): Promise<number[] | null> {
	if (!EMBED_ENABLED) return null;
	if (embeddingCache.has(text)) return embeddingCache.get(text) ?? null;
	const result = await embedOllama(MODEL, text, ollamaConfig());
	embeddingCache.set(text, result);
	return result;
}

async function runVariant(
	variant: Variant,
	modifierId: string,
	presets: (typeof CAPABILITY_GAP_PROFILES)[number]["presets"],
	sample: Sample,
	trial: number,
): Promise<RecordRow> {
	const system =
		variant === "current"
			? buildSystemPrompt(presets)
			: buildCavemanSystemPrompt(presets);
	const user =
		variant === "current"
			? buildUserPromptForPresets(sample.before, presets)
			: buildCavemanUserPrompt(sample.before, presets);
	const label = `${variant}:${modifierId}:${sample.id}#${trial}`;
	try {
		const response = await callOllamaChat({
			model: MODEL,
			system,
			user,
			format: TEXT_SCHEMA,
			timeoutMs: 60_000,
			label,
		});
		const output = normalize(extractText(response.raw));
		const [beforeEmbedding, afterEmbedding] = await Promise.all([
			embedding(sample.before),
			embedding(output),
		]);
		const guards = runGuards(sample.before, output, modifierId);
		const capabilityPass = sample.checks
			? sample.checks.filter((check) => check.pass(output)).length /
				sample.checks.length
			: null;
		return {
			variant,
			modifierId,
			sampleId: sample.id,
			sampleKind: sample.kind,
			trial,
			systemChars: system.length,
			userChars: user.length,
			output,
			promptTokens: response.speed.promptTokens,
			promptMs: response.speed.promptMs ?? null,
			genTokens: response.speed.genTokens,
			genMs: response.speed.genMs,
			wallMs: response.speed.wallMs,
			surfaceDelta: surfaceDelta(sample.before, output),
			semanticDelta: semanticDelta(beforeEmbedding, afterEmbedding),
			magnitude: magnitudeVerdict(
				surfaceDelta(sample.before, output),
				semanticDelta(beforeEmbedding, afterEmbedding),
				modifierId,
			),
			guardPass: guards.pass,
			guardResults: guards.results,
			capabilityPass,
			judge: null,
			error: null,
		};
	} catch (error) {
		return {
			variant,
			modifierId,
			sampleId: sample.id,
			sampleKind: sample.kind,
			trial,
			systemChars: system.length,
			userChars: user.length,
			output: "",
			promptTokens: null,
			promptMs: null,
			genTokens: null,
			genMs: null,
			wallMs: 0,
			surfaceDelta: 0,
			semanticDelta: null,
			magnitude: "error",
			guardPass: false,
			guardResults: [],
			capabilityPass: null,
			judge: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function pctDelta(current: number, caveman: number): number {
	return current === 0 ? 0 : ((caveman - current) / current) * 100;
}

function overall(aggregates: Aggregate[], variant: Variant): Aggregate {
	const rows = aggregates.filter((row) => row.variant === variant);
	return {
		variant,
		modifierId: "ALL",
		runs: rows.reduce((sum, row) => sum + row.runs, 0),
		errors: rows.reduce((sum, row) => sum + row.errors, 0),
		promptChars: mean(rows.map((row) => row.promptChars)),
		promptTokens: mean(rows.map((row) => row.promptTokens)),
		promptMs: mean(rows.map((row) => row.promptMs)),
		genTokens: mean(rows.map((row) => row.genTokens)),
		genMs: mean(rows.map((row) => row.genMs)),
		modelMs: mean(rows.map((row) => row.modelMs)),
		wallMs: mean(rows.map((row) => row.wallMs)),
		guardPassRate: mean(rows.map((row) => row.guardPassRate)),
		capability: mean(
			rows
				.map((row) => row.capability)
				.filter((value): value is number => value !== null),
		),
		style: mean(
			rows
				.map((row) => row.style)
				.filter((value): value is number => value !== null),
		),
		accuracy: mean(rows.map((row) => row.accuracy)),
		composite: mean(rows.map((row) => row.composite)),
	};
}

function reportMarkdown(
	generatedAt: string,
	aggregates: Aggregate[],
	rows: RecordRow[],
): string {
	const current = overall(aggregates, "current");
	const caveman = overall(aggregates, "caveman-ultra");
	const lines = [
		"# Caveman prompt compression experiment",
		"",
		`Generated: ${generatedAt}`,
		`Model: \`${MODEL}\` via local Ollama; temperature 0; JSON schema output; ${TRIALS} paired trial(s) per case.`,
		`Coverage: ${SELECTED.length} modifier profiles, ${rows.length / 2} paired cases. Current and Caveman order was counterbalanced; warm-up excluded.`,
		"",
		"## Overall",
		"",
		"| Metric | Current | Caveman ultra | Change |",
		"| --- | ---: | ---: | ---: |",
		`| Prompt characters | ${current.promptChars.toFixed(0)} | ${caveman.promptChars.toFixed(0)} | ${pctDelta(current.promptChars, caveman.promptChars).toFixed(1)}% |`,
		`| Ollama prompt tokens | ${current.promptTokens.toFixed(0)} | ${caveman.promptTokens.toFixed(0)} | ${pctDelta(current.promptTokens, caveman.promptTokens).toFixed(1)}% |`,
		`| Prompt evaluation | ${current.promptMs.toFixed(0)} ms | ${caveman.promptMs.toFixed(0)} ms | ${pctDelta(current.promptMs, caveman.promptMs).toFixed(1)}% |`,
		`| Generation | ${current.genMs.toFixed(0)} ms | ${caveman.genMs.toFixed(0)} ms | ${pctDelta(current.genMs, caveman.genMs).toFixed(1)}% |`,
		`| Total model time | ${current.modelMs.toFixed(0)} ms | ${caveman.modelMs.toFixed(0)} ms | ${pctDelta(current.modelMs, caveman.modelMs).toFixed(1)}% |`,
		`| End-to-end wall time | ${current.wallMs.toFixed(0)} ms | ${caveman.wallMs.toFixed(0)} ms | ${pctDelta(current.wallMs, caveman.wallMs).toFixed(1)}% |`,
	];
	if (JUDGE_ENABLED) {
		lines.push(
			`| Composite quality | ${current.composite.toFixed(1)} | ${caveman.composite.toFixed(1)} | ${(caveman.composite - current.composite).toFixed(1)} points |`,
			`| Style | ${(current.style ?? 0).toFixed(1)} | ${(caveman.style ?? 0).toFixed(1)} | ${((caveman.style ?? 0) - (current.style ?? 0)).toFixed(1)} points |`,
			`| Accuracy | ${current.accuracy.toFixed(1)} | ${caveman.accuracy.toFixed(1)} | ${(caveman.accuracy - current.accuracy).toFixed(1)} points |`,
		);
	}
	lines.push(
		`| Guard pass | ${(current.guardPassRate * 100).toFixed(1)}% | ${(caveman.guardPassRate * 100).toFixed(1)}% | ${((caveman.guardPassRate - current.guardPassRate) * 100).toFixed(1)} points |`,
		`| Capability checks | ${((current.capability ?? 0) * 100).toFixed(1)}% | ${((caveman.capability ?? 0) * 100).toFixed(1)}% | ${(((caveman.capability ?? 0) - (current.capability ?? 0)) * 100).toFixed(1)} points |`,
		"",
		"## By modifier",
		"",
		"| Modifier | Prompt tokens | Model time | Quality | Guard | Capability |",
		"| --- | ---: | ---: | ---: | ---: | ---: |",
	);
	for (const modifier of SELECTED.map((profile) => profile.id)) {
		const a = aggregates.find(
			(row) => row.variant === "current" && row.modifierId === modifier,
		)!;
		const b = aggregates.find(
			(row) => row.variant === "caveman-ultra" && row.modifierId === modifier,
		)!;
		lines.push(
			`| ${modifier} | ${a.promptTokens.toFixed(0)} / ${b.promptTokens.toFixed(0)} (${pctDelta(a.promptTokens, b.promptTokens).toFixed(0)}%) | ${a.modelMs.toFixed(0)} / ${b.modelMs.toFixed(0)} ms (${pctDelta(a.modelMs, b.modelMs).toFixed(0)}%) | ${JUDGE_ENABLED ? `${a.composite.toFixed(1)} / ${b.composite.toFixed(1)} (${(b.composite - a.composite).toFixed(1)})` : "not judged"} | ${(a.guardPassRate * 100).toFixed(0)}% / ${(b.guardPassRate * 100).toFixed(0)}% | ${a.capability === null ? "n/a" : `${(a.capability * 100).toFixed(0)}%`} / ${b.capability === null ? "n/a" : `${(b.capability * 100).toFixed(0)}%`} |`,
		);
	}
	lines.push(
		"",
		"## Method and limits",
		"",
		"The experiment reuses WinSTT's existing corpus, capability checks, output normalizer, deterministic guards, semantic/surface metrics, and judge rubric. Ollama's `prompt_eval_count`, `prompt_eval_duration`, and `eval_duration` provide token and model-time measurements. Prompt variants run as adjacent pairs with alternating order.",
		"",
		"Gemma judges Gemma here because the requested local installation has no independent judge model of comparable strength. This is useful for paired direction, not an absolute quality certificate. Production conversion should require no material deterministic capability regression and a targeted repeat on any weak modifiers.",
		"",
		`Raw records: \`${OUT.replaceAll("\\", "/")}\`.`,
		"",
	);
	return lines.join("\n");
}

async function main(): Promise<void> {
	console.log(`Caveman prompt experiment: ${MODEL}`);
	console.log(
		`${SELECTED.length} modifiers, ${CORPUS_LIMIT} corpus samples, ${TRIALS} trial(s)`,
	);
	await callOllamaChat({
		model: MODEL,
		system: "Return the supplied text unchanged in JSON field `text`.",
		user: "warm",
		format: TEXT_SCHEMA,
		numPredict: 16,
		timeoutMs: 60_000,
		label: "warm-up",
	});
	console.log("Warm-up complete; excluded from metrics.");

	const checkpoint = `${OUT}.partial`;
	const rows: RecordRow[] =
		has("resume") && existsSync(checkpoint)
			? (
					JSON.parse(readFileSync(checkpoint, "utf8")) as {
						rows: RecordRow[];
					}
				).rows
			: [];
	if (rows.length > 0) console.log(`Resuming from ${rows.length} rows.`);
	const allSamples = samples();
	const selectedIds = new Set(SELECTED.map((profile) => profile.id));
	const retained = rows.filter((row) => {
		const sample = allSamples.find(
			(candidate) => candidate.id === row.sampleId,
		);
		return (
			selectedIds.has(row.modifierId) &&
			row.trial <= TRIALS &&
			sample !== undefined &&
			sampleApplies(sample, row.modifierId)
		);
	});
	if (retained.length !== rows.length) {
		console.log(
			`Discarding ${rows.length - retained.length} out-of-scope rows.`,
		);
		rows.splice(0, rows.length, ...retained);
	}
	let pairIndex = 0;
	for (const profile of SELECTED) {
		const applicable = allSamples.filter((sample) =>
			sampleApplies(sample, profile.id),
		);
		for (const sample of applicable) {
			for (let trial = 1; trial <= TRIALS; trial++) {
				const order: Variant[] =
					pairIndex++ % 2 === 0
						? ["current", "caveman-ultra"]
						: ["caveman-ultra", "current"];
				const pair: RecordRow[] = [];
				for (const variant of order) {
					let existing = rows.find(
						(row) =>
							row.variant === variant &&
							row.modifierId === profile.id &&
							row.sampleId === sample.id &&
							row.trial === trial,
					);
					if (
						has("retry-errors") &&
						existing !== undefined &&
						existing.error !== null
					) {
						rows.splice(rows.indexOf(existing), 1);
						existing = undefined;
					}
					pair.push(
						existing ??
							(await runVariant(
								variant,
								profile.id,
								profile.presets,
								sample,
								trial,
							)),
					);
				}
				for (const row of pair) {
					if (row.error === null && row.judge === null && JUDGE_ENABLED) {
						try {
							row.judge = await judge(
								profile.id,
								sample,
								row.output,
								`${row.variant}:${profile.id}:${sample.id}#${trial}`,
							);
						} catch (error) {
							console.warn(
								`Judge failed: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
					if (!rows.includes(row)) rows.push(row);
				}
				if (pairIndex % 5 === 0) {
					mkdirSync(dirname(OUT), { recursive: true });
					writeFileSync(
						checkpoint,
						`${JSON.stringify({ model: MODEL, rows }, null, "\t")}\n`,
					);
				}
				const now = aggregate(pair);
				const current = now.find((row) => row.variant === "current")!;
				const caveman = now.find((row) => row.variant === "caveman-ultra")!;
				console.log(
					`${profile.id.padEnd(17)} ${sample.id.padEnd(38)} ` +
						`tokens ${current.promptTokens.toFixed(0)}>${caveman.promptTokens.toFixed(0)} ` +
						`model ${current.modelMs.toFixed(0)}>${caveman.modelMs.toFixed(0)}ms ` +
						`quality ${current.composite.toFixed(0)}>${caveman.composite.toFixed(0)}`,
				);
			}
		}
	}

	const aggregates = aggregate(rows);
	const generatedAt = new Date().toISOString();
	const payload = {
		generatedAt,
		model: MODEL,
		trials: TRIALS,
		corpusLimit: CORPUS_LIMIT,
		capabilityCases: CAPABILITY_ENABLED,
		targetedCapabilityCases: TARGETED_CAPABILITY,
		modifiers: SELECTED.map((profile) => profile.id),
		judge: JUDGE_ENABLED ? MODEL : null,
		embed: EMBED_ENABLED ? MODEL : null,
		aggregates,
		overall: {
			current: overall(aggregates, "current"),
			cavemanUltra: overall(aggregates, "caveman-ultra"),
		},
		rows,
	};
	mkdirSync(dirname(OUT), { recursive: true });
	mkdirSync(dirname(REPORT), { recursive: true });
	writeFileSync(OUT, `${JSON.stringify(payload, null, "\t")}\n`);
	writeFileSync(REPORT, reportMarkdown(generatedAt, aggregates, rows));
	console.log(`Raw results: ${OUT}`);
	console.log(`Report: ${REPORT}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

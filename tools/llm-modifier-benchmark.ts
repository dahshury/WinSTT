import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isLiteOllamaModel } from "../src/entities/llm-catalog/lib/lite-model";
import { buildSystemPrompt } from "../src/shared/lib/preset-prompts";
import {
	callOllamaChat,
	callOpenRouterChat,
	embedOllama,
	extractText,
	ollamaConfig,
	type Provider,
	type SpeedSample,
	TEXT_SCHEMA,
} from "./lib/postprocess/clients";
import {
	BENCHMARK_CORPUS,
	CAPABILITY_GAP_CASES,
	CAPABILITY_GAP_PROFILES,
	type CapabilityCheck,
	type PresetProfile,
} from "./lib/postprocess/corpus";
import {
	buildJudgeUser,
	JUDGE_SCHEMA,
	JUDGE_SYSTEM,
	type JudgeScores,
	parseJudge,
} from "./lib/postprocess/judge";
import {
	type GuardReport,
	magnitudeVerdict,
	runGuards,
	semanticDelta,
	surfaceDelta,
} from "./lib/postprocess/metrics";
import { normalize } from "./lib/postprocess/normalize";
import { buildUserPromptForPresets } from "./lib/postprocess/prompts";
import { renderHtmlReport } from "./lib/postprocess/report";
import type {
	BenchmarkReport,
	ModifierModelAgg,
	TrialRecord,
} from "./lib/postprocess/types";

// ── CLI ─────────────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
	const prefix = `--${name}=`;
	const arg = process.argv.find((a) => a.startsWith(prefix));
	return arg?.slice(prefix.length);
}
function has(name: string): boolean {
	return process.argv.includes(`--${name}`);
}
function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

const RUNNER_PROVIDER = (flag("runner-provider") ??
	process.env["PROVIDER"] ??
	"ollama") as Provider;
const JUDGE_ENABLED = !has("no-judge");
const JUDGE_PROVIDER = (flag("judge-provider") ?? RUNNER_PROVIDER) as Provider;
const EMBED_ENABLED = !has("no-embed");
const TRIALS = Math.max(1, Number(flag("trials") ?? 1));
const CORPUS_LIMIT = Math.max(0, Number(flag("corpus-limit") ?? 3));
const CAPABILITY_ENABLED = !has("no-capability");
const OUT_DIR = flag("out") ?? join(import.meta.dir, "out");
const OPENROUTER_KEY =
	flag("openrouter-key") ?? process.env["OPENROUTER_API_KEY"];

const RUNNERS = list(
	flag("runners") ??
		process.env["OLLAMA_MODELS"] ??
		process.env["OLLAMA_MODEL"] ??
		"gemma4:e4b",
);
const JUDGE_MODEL =
	flag("judge-model") ??
	process.env["JUDGE_MODEL"] ??
	(JUDGE_PROVIDER === "openrouter"
		? (process.env["OPENROUTER_MODEL"] ?? "google/gemini-3.1-flash-lite")
		: RUNNERS[0]);
const EMBED_MODEL =
	flag("embed-model") ?? process.env["EMBED_MODEL"] ?? RUNNERS[0];

const SELECTED_MODIFIERS = (() => {
	const arg = flag("modifiers");
	if (!arg || arg === "all") return CAPABILITY_GAP_PROFILES.map((p) => p.id);
	const ids = new Set(list(arg));
	return CAPABILITY_GAP_PROFILES.filter((p) => ids.has(p.id)).map((p) => p.id);
})();

// ── samples ─────────────────────────────────────────────────────────────────

interface Sample {
	id: string;
	kind: "corpus" | "capability";
	before: string;
	reference: string | undefined;
	checks: readonly CapabilityCheck[] | undefined;
	/** Modifier ids this sample applies to; empty = all selected modifiers. */
	appliesTo: readonly string[];
}

function buildSamples(): Sample[] {
	const samples: Sample[] = [];
	for (const item of BENCHMARK_CORPUS.slice(0, CORPUS_LIMIT)) {
		samples.push({
			id: item.id,
			kind: "corpus",
			before: item.before,
			reference: item.after,
			checks: undefined,
			appliesTo: [],
		});
	}
	if (CAPABILITY_ENABLED) {
		for (const c of CAPABILITY_GAP_CASES) {
			samples.push({
				id: c.id,
				kind: "capability",
				before: c.before,
				reference: undefined,
				checks: c.checks,
				appliesTo: c.profiles ?? [],
			});
		}
	}
	return samples;
}

function sampleApplies(sample: Sample, modifierId: string): boolean {
	return sample.appliesTo.length === 0 || sample.appliesTo.includes(modifierId);
}

function profileFor(modifierId: string): PresetProfile {
	const p = CAPABILITY_GAP_PROFILES.find((x) => x.id === modifierId);
	if (!p) throw new Error(`unknown modifier profile: ${modifierId}`);
	return p;
}

// ── embeddings cache ────────────────────────────────────────────────────────

const embedCache = new Map<string, number[] | null>();
async function embed(text: string): Promise<number[] | null> {
	if (!EMBED_ENABLED || !EMBED_MODEL) return null;
	const cached = embedCache.get(text);
	if (cached !== undefined) return cached;
	const vec = await embedOllama(EMBED_MODEL, text, ollamaConfig());
	embedCache.set(text, vec);
	return vec;
}

// ── model calls ─────────────────────────────────────────────────────────────

async function runModel(
	model: string,
	system: string,
	user: string,
	label: string,
): Promise<{ output: string; speed: SpeedSample }> {
	if (RUNNER_PROVIDER === "openrouter") {
		if (!OPENROUTER_KEY)
			throw new Error("OPENROUTER_API_KEY required for openrouter runner");
		const res = await callOpenRouterChat({
			model,
			system,
			user,
			jsonSchema: { name: "cleaned_text", schema: TEXT_SCHEMA },
			label,
			apiKey: OPENROUTER_KEY,
		});
		return { output: normalize(extractText(res.raw)), speed: res.speed };
	}
	const res = await callOllamaChat({
		model,
		system,
		user,
		format: TEXT_SCHEMA,
		label,
	});
	return { output: normalize(extractText(res.raw)), speed: res.speed };
}

async function runJudge(
	modifierId: string,
	before: string,
	after: string,
	reference: string | undefined,
	label: string,
): Promise<JudgeScores | null> {
	if (!JUDGE_ENABLED || !JUDGE_MODEL) return null;
	const user = buildJudgeUser({ modifierId, before, after, reference });
	try {
		if (JUDGE_PROVIDER === "openrouter") {
			if (!OPENROUTER_KEY)
				throw new Error("OPENROUTER_API_KEY required for openrouter judge");
			const res = await callOpenRouterChat({
				model: JUDGE_MODEL,
				system: JUDGE_SYSTEM,
				user,
				jsonSchema: { name: "judge_scores", schema: JUDGE_SCHEMA },
				label: `${label}:judge`,
				apiKey: OPENROUTER_KEY,
			});
			return parseJudge(res.raw);
		}
		const res = await callOllamaChat({
			model: JUDGE_MODEL,
			system: JUDGE_SYSTEM,
			user,
			format: JUDGE_SCHEMA,
			numPredict: 1024,
			label: `${label}:judge`,
		});
		return parseJudge(res.raw);
	} catch (err) {
		console.warn(
			`  judge error (${label}): ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

// ── aggregation helpers ─────────────────────────────────────────────────────

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}
function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[mid - 1]! + sorted[mid]!) / 2
		: sorted[mid]!;
}

function trialAccuracy(t: TrialRecord): number | null {
	const parts: number[] = [];
	if (t.judge) parts.push(t.judge.meaningPreservation, t.judge.fidelity);
	if (t.capabilityPass !== null) parts.push(t.capabilityPass * 100);
	if (parts.length === 0) {
		// No judge and no checks: fall back to a semantic-preservation proxy.
		if (t.semanticDelta !== null && t.modifierId !== "translate")
			return Math.min(100, Math.max(0, (1 - t.semanticDelta) * 100));
		return null;
	}
	return mean(parts);
}

function aggregate(trials: TrialRecord[]): ModifierModelAgg[] {
	const groups = new Map<string, TrialRecord[]>();
	for (const t of trials) {
		const key = `${t.modifierId} ${t.model}`;
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
	}
	const aggs: ModifierModelAgg[] = [];
	for (const [key, group] of groups) {
		const [modifierId, model] = key.split(" ") as [string, string];
		const ok = group.filter((t) => t.error === null);
		const styleScores = ok
			.filter((t) => t.judge !== null)
			.map((t) => t.judge!.styleMatch);
		const accScores = ok
			.map(trialAccuracy)
			.filter((v): v is number => v !== null);
		const guardPassRate = ok.length
			? mean(ok.map((t) => (t.guards.pass ? 1 : 0)))
			: 0;
		const style = styleScores.length ? mean(styleScores) : null;
		const accuracy = accScores.length ? mean(accScores) : 0;
		const base = style !== null ? 0.5 * style + 0.5 * accuracy : accuracy;
		const composite = base * (0.5 + 0.5 * guardPassRate);

		const capTrials = ok.filter((t) => t.capabilityPass !== null);
		const adherence = capTrials.length
			? mean(capTrials.map((t) => t.capabilityPass!))
			: null;

		const semDeltas = ok
			.map((t) => t.semanticDelta)
			.filter((v): v is number => v !== null);
		const genMsAll = ok
			.map((t) => t.speed.genMs)
			.filter((v): v is number => v !== null);
		const tpsAll = ok
			.map((t) => t.speed.tokensPerSec)
			.filter((v): v is number => v !== null);

		const magnitudeCounts: Record<string, number> = {};
		for (const t of ok)
			magnitudeCounts[t.magnitude] = (magnitudeCounts[t.magnitude] ?? 0) + 1;

		aggs.push({
			modifierId,
			model,
			trials: group.length,
			errors: group.length - ok.length,
			style,
			accuracy,
			composite,
			guardPassRate,
			adherence,
			meanSurfaceDelta: ok.length ? mean(ok.map((t) => t.surfaceDelta)) : 0,
			meanSemanticDelta: semDeltas.length ? mean(semDeltas) : null,
			medianWallMs: ok.length ? median(ok.map((t) => t.speed.wallMs)) : 0,
			medianGenMs: genMsAll.length ? median(genMsAll) : null,
			medianTokensPerSec: tpsAll.length ? median(tpsAll) : null,
			magnitudeCounts,
			judgeCoverage: ok.length ? styleScores.length / ok.length : 0,
		});
	}
	aggs.sort(
		(a, b) =>
			a.modifierId.localeCompare(b.modifierId) ||
			a.model.localeCompare(b.model),
	);
	return aggs;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const samples = buildSamples();
	const corpusCount = samples.filter((s) => s.kind === "corpus").length;
	const capCount = samples.filter((s) => s.kind === "capability").length;

	console.log("LLM modifier benchmark");
	console.log(`  runner provider : ${RUNNER_PROVIDER}`);
	console.log(`  runners         : ${RUNNERS.join(", ")}`);
	console.log(
		`  judge           : ${JUDGE_ENABLED ? `${JUDGE_PROVIDER} / ${JUDGE_MODEL}` : "disabled"}`,
	);
	console.log(
		`  embeddings      : ${EMBED_ENABLED ? EMBED_MODEL : "disabled"}`,
	);
	console.log(`  modifiers       : ${SELECTED_MODIFIERS.join(", ")}`);
	console.log(
		`  samples         : ${corpusCount} corpus + ${capCount} capability, trials=${TRIALS}`,
	);
	console.log("");

	const trials: TrialRecord[] = [];
	for (const model of RUNNERS) {
		const lite = RUNNER_PROVIDER === "ollama" && isLiteOllamaModel(model);
		console.log(`=== ${model} (${lite ? "lite" : "full"} prompt tier) ===`);
		for (const modifierId of SELECTED_MODIFIERS) {
			const profile = profileFor(modifierId);
			const system = buildSystemPrompt(profile.presets, { lite });
			const applicable = samples.filter((s) => sampleApplies(s, modifierId));
			for (const sample of applicable) {
				const user = buildUserPromptForPresets(sample.before, profile.presets);
				for (let trial = 1; trial <= TRIALS; trial++) {
					const label = `${model}:${modifierId}:${sample.id}#${trial}`;
					try {
						const { output, speed } = await runModel(
							model,
							system,
							user,
							label,
						);
						const [embBefore, embAfter] = await Promise.all([
							embed(sample.before),
							embed(output),
						]);
						const surface = surfaceDelta(sample.before, output);
						const semantic = semanticDelta(embBefore, embAfter);
						const guards: GuardReport = runGuards(
							sample.before,
							output,
							modifierId,
						);
						const capabilityPass = sample.checks
							? sample.checks.filter((c) => c.pass(output)).length /
								sample.checks.length
							: null;
						const judge = await runJudge(
							modifierId,
							sample.before,
							output,
							sample.reference,
							label,
						);
						trials.push({
							modifierId,
							model,
							sampleId: sample.id,
							sampleKind: sample.kind,
							trial,
							output,
							speed,
							surfaceDelta: surface,
							semanticDelta: semantic,
							magnitude: magnitudeVerdict(surface, semantic, modifierId),
							guards,
							judge,
							capabilityPass,
							error: null,
						});
						const styleStr = judge ? `style ${judge.styleMatch}` : "no-judge";
						console.log(
							`  ${modifierId.padEnd(16)} ${sample.id.padEnd(34)} ` +
								`${guards.pass ? "guards✓" : "guards✗"} ${styleStr.padEnd(12)} ` +
								`Δs ${surface.toFixed(2)} Δm ${semantic === null ? "—" : semantic.toFixed(2)} ` +
								`${Math.round(speed.wallMs)}ms`,
						);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						console.log(`  FAIL ${label}: ${message.slice(0, 140)}`);
						trials.push(errorTrial(model, modifierId, sample, trial, message));
					}
				}
			}
		}
	}

	const aggregates = aggregate(trials);
	const report: BenchmarkReport = {
		generatedAt: new Date().toISOString(),
		runnerProvider: RUNNER_PROVIDER,
		judgeProvider: JUDGE_ENABLED ? JUDGE_PROVIDER : null,
		judgeModel: JUDGE_ENABLED ? (JUDGE_MODEL ?? null) : null,
		embedModel: EMBED_ENABLED ? (EMBED_MODEL ?? null) : null,
		models: RUNNERS,
		modifiers: SELECTED_MODIFIERS,
		trialsPerCell: TRIALS,
		samples: { corpus: corpusCount, capability: capCount },
		aggregates,
		trials,
	};

	mkdirSync(OUT_DIR, { recursive: true });
	const jsonPath = join(OUT_DIR, "llm-modifier-benchmark.json");
	const htmlPath = join(OUT_DIR, "llm-modifier-benchmark.html");
	writeFileSync(jsonPath, `${JSON.stringify(report, null, "\t")}\n`);
	writeFileSync(htmlPath, renderHtmlReport(report));

	printSummary(aggregates);
	console.log(`\nJSON  written to ${jsonPath}`);
	console.log(`Chart written to ${htmlPath}`);
}

function errorTrial(
	model: string,
	modifierId: string,
	sample: Sample,
	trial: number,
	message: string,
): TrialRecord {
	return {
		modifierId,
		model,
		sampleId: sample.id,
		sampleKind: sample.kind,
		trial,
		output: "",
		speed: {
			wallMs: 0,
			genMs: null,
			genTokens: null,
			promptTokens: null,
			tokensPerSec: null,
			source: "wall",
		},
		surfaceDelta: 0,
		semanticDelta: null,
		magnitude: "error",
		guards: { results: [], pass: false },
		judge: null,
		capabilityPass: null,
		error: message,
	};
}

function printSummary(aggs: ModifierModelAgg[]): void {
	console.log("\n── summary (composite quality / style / accuracy / speed) ──");
	console.log(
		`${"modifier".padEnd(16)} ${"model".padEnd(24)} ${"comp".padStart(5)} ${"style".padStart(5)} ${"acc".padStart(5)} ${"guard".padStart(6)} ${"tok/s".padStart(6)} ${"ms".padStart(6)}`,
	);
	for (const a of aggs) {
		console.log(
			`${a.modifierId.padEnd(16)} ${a.model.padEnd(24)} ` +
				`${a.composite.toFixed(0).padStart(5)} ` +
				`${(a.style === null ? "—" : a.style.toFixed(0)).padStart(5)} ` +
				`${a.accuracy.toFixed(0).padStart(5)} ` +
				`${(a.guardPassRate * 100).toFixed(0).padStart(5)}% ` +
				`${(a.medianTokensPerSec === null ? "—" : a.medianTokensPerSec.toFixed(0)).padStart(6)} ` +
				`${a.medianWallMs.toFixed(0).padStart(6)}`,
		);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

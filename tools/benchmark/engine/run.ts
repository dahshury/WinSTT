import { isLiteOllamaModel } from "@/entities/llm-catalog/lib/lite-model";
import { buildSystemPrompt } from "@/shared/lib/preset-prompts";

import { aggregate } from "../../lib/postprocess/aggregate";
import {
	callOllamaChat,
	callOpenRouterChat,
	embedOllama,
	extractText,
	type OllamaConfig,
	type SpeedSample,
	TEXT_SCHEMA,
} from "../../lib/postprocess/clients";
import {
	BENCHMARK_CORPUS,
	CAPABILITY_GAP_CASES,
	CAPABILITY_GAP_PROFILES,
	type CapabilityCheck,
	type PresetProfile,
} from "../../lib/postprocess/corpus";
import {
	buildJudgeUser,
	JUDGE_SCHEMA,
	JUDGE_SYSTEM,
	type JudgeScores,
	parseJudge,
} from "../../lib/postprocess/judge";
import {
	type GuardReport,
	magnitudeVerdict,
	runGuards,
	semanticDelta,
	surfaceDelta,
} from "../../lib/postprocess/metrics";
import { normalize } from "../../lib/postprocess/normalize";
import { buildUserPromptForPresets } from "../../lib/postprocess/prompts";
import type { TrialRecord } from "../../lib/postprocess/types";
import type { BenchmarkConfig, RunProgress, RunnerSpec } from "./types";

interface Sample {
	id: string;
	kind: "corpus" | "capability";
	before: string;
	reference: string | undefined;
	checks: readonly CapabilityCheck[] | undefined;
	appliesTo: readonly string[];
}

function buildSamples(config: BenchmarkConfig): Sample[] {
	const samples: Sample[] = [];
	for (const item of BENCHMARK_CORPUS.slice(0, config.corpusLimit)) {
		samples.push({
			id: item.id,
			kind: "corpus",
			before: item.before,
			reference: item.after,
			checks: undefined,
			appliesTo: [],
		});
	}
	if (config.includeCapability) {
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

function profileFor(modifierId: string): PresetProfile | null {
	return CAPABILITY_GAP_PROFILES.find((p) => p.id === modifierId) ?? null;
}

function ollamaCfg(config: BenchmarkConfig): OllamaConfig {
	return { endpoint: config.ollamaEndpoint, numCtx: 16384 };
}

async function runRunner(
	config: BenchmarkConfig,
	runner: RunnerSpec,
	system: string,
	user: string,
	label: string,
): Promise<{ output: string; speed: SpeedSample }> {
	if (runner.provider === "openrouter") {
		if (!config.openrouterKey)
			throw new Error("OpenRouter API key required for a cloud runner");
		const res = await callOpenRouterChat({
			model: runner.model,
			system,
			user,
			jsonSchema: { name: "cleaned_text", schema: TEXT_SCHEMA },
			reasoningEffort: config.thinkingEffort,
			label,
			apiKey: config.openrouterKey,
		});
		return { output: normalize(extractText(res.raw)), speed: res.speed };
	}
	const res = await callOllamaChat({
		model: runner.model,
		system,
		user,
		format: TEXT_SCHEMA,
		think: config.thinkingEffort !== "off",
		cfg: ollamaCfg(config),
		label,
	});
	return { output: normalize(extractText(res.raw)), speed: res.speed };
}

async function runJudge(
	config: BenchmarkConfig,
	modifierId: string,
	before: string,
	after: string,
	reference: string | undefined,
	label: string,
): Promise<JudgeScores | null> {
	if (!config.judgeEnabled || !config.judgeModel) return null;
	const user = buildJudgeUser({ modifierId, before, after, reference });
	try {
		if (config.judgeProvider === "openrouter") {
			if (!config.openrouterKey)
				throw new Error("OpenRouter API key required for a cloud judge");
			const res = await callOpenRouterChat({
				model: config.judgeModel,
				system: JUDGE_SYSTEM,
				user,
				jsonSchema: { name: "judge_scores", schema: JUDGE_SCHEMA },
				label: `${label}:judge`,
				apiKey: config.openrouterKey,
			});
			return parseJudge(res.raw);
		}
		const res = await callOllamaChat({
			model: config.judgeModel,
			system: JUDGE_SYSTEM,
			user,
			format: JUDGE_SCHEMA,
			numPredict: 1024,
			cfg: ollamaCfg(config),
			label: `${label}:judge`,
		});
		return parseJudge(res.raw);
	} catch (err) {
		console.warn(`judge error (${label})`, err);
		return null;
	}
}

export interface RunResult {
	trials: TrialRecord[];
	durationMs: number;
}

export interface RunHandle {
	onProgress?: (p: RunProgress) => void;
	onTrial?: (t: TrialRecord) => void;
	signal?: AbortSignal;
}

/** Execute the benchmark sweep entirely in the browser: reuse the app's system
 *  prompt composition + the shared metric/judge engine, talking to providers
 *  over fetch. Sequential so speed numbers stay comparable. */
export async function runBenchmark(
	config: BenchmarkConfig,
	handle: RunHandle = {},
): Promise<RunResult> {
	const started = performance.now();
	const samples = buildSamples(config);
	const embedCache = new Map<string, number[] | null>();
	const embed = async (text: string): Promise<number[] | null> => {
		if (!config.embedEnabled || !config.embedModel) return null;
		const cached = embedCache.get(text);
		if (cached !== undefined) return cached;
		const vec = await embedOllama(config.embedModel, text, ollamaCfg(config));
		embedCache.set(text, vec);
		return vec;
	};

	// Total unit count for the progress bar (identical per runner).
	let total = 0;
	for (const modifierId of config.modifiers)
		for (const sample of samples)
			if (sampleApplies(sample, modifierId)) total += config.trials;
	total *= config.runners.length;

	const trials: TrialRecord[] = [];
	let done = 0;
	for (const runner of config.runners) {
		const lite =
			runner.provider === "ollama" && isLiteOllamaModel(runner.model);
		for (const modifierId of config.modifiers) {
			const profile = profileFor(modifierId);
			if (!profile) continue;
			const system = buildSystemPrompt(profile.presets, { lite });
			const applicable = samples.filter((s) => sampleApplies(s, modifierId));
			for (const sample of applicable) {
				const user = buildUserPromptForPresets(sample.before, profile.presets);
				for (let trial = 1; trial <= config.trials; trial++) {
					if (handle.signal?.aborted) return finish(trials, started);
					const label = `${runner.model}:${modifierId}:${sample.id}#${trial}`;
					handle.onProgress?.({ done, total, label, phase: "runner" });
					const record = await runOne(
						config,
						runner,
						system,
						user,
						sample,
						modifierId,
						trial,
						label,
						embed,
						handle,
					);
					trials.push(record);
					handle.onTrial?.(record);
					done += 1;
				}
			}
		}
	}
	handle.onProgress?.({ done, total, label: "", phase: "done" });
	return finish(trials, started);
}

function finish(trials: TrialRecord[], started: number): RunResult {
	return { trials, durationMs: performance.now() - started };
}

async function runOne(
	config: BenchmarkConfig,
	runner: RunnerSpec,
	system: string,
	user: string,
	sample: Sample,
	modifierId: string,
	trial: number,
	label: string,
	embed: (text: string) => Promise<number[] | null>,
	handle: RunHandle,
): Promise<TrialRecord> {
	try {
		const { output, speed } = await runRunner(
			config,
			runner,
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
		const guards: GuardReport = runGuards(sample.before, output, modifierId);
		const capabilityPass = sample.checks
			? sample.checks.filter((c) => c.pass(output)).length /
				sample.checks.length
			: null;
		handle.onProgress?.({
			done: 0,
			total: 0,
			label: `${label} · judging`,
			phase: "judge",
		});
		const judge = await runJudge(
			config,
			modifierId,
			sample.before,
			output,
			sample.reference,
			label,
		);
		return {
			modifierId,
			model: runner.model,
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
		};
	} catch (err) {
		return {
			modifierId,
			model: runner.model,
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
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export { aggregate };

import type { AuthorSlice, ResolvedAuthor } from "./author-usage";
import { toDayKey } from "./word-stats";
import type {
	TranscriptionHistoryEntry,
	TtsHistoryEntry,
} from "../model/history-store";

/** One donut/pie slice: a cost bucket with its share and display color. */
export interface CostSlice {
	/** Stable React key. */
	key: string;
	label: string;
	/** USD summed into this slice. */
	cost: number;
	/** Share of the counted cost, `0`–`100`, rounded to a whole percent. */
	pct: number;
	/** `true` when any contributing figure is a client-side estimate. */
	estimate: boolean;
	/** CSS color for the slice (a token or `color-mix(...)`). */
	color: string;
}

/** One horizontal cost bar: a model's spend and its share of the total. */
export interface CostBar {
	key: string;
	label: string;
	cost: number;
	pct: number;
	estimate: boolean;
}

export interface CostAnalytics {
	/** Grand total USD across every cloud stage in the filtered window. */
	total: number;
	/** `true` when any component of `total` is an estimate (marked with `~`). */
	estimated: boolean;
	/** Per-modality subtotals (also surfaced as `byModality` slices). */
	stt: number;
	llm: number;
	tts: number;
	/** Speech-to-text vs language-model vs text-to-speech spend (donut). */
	byModality: CostSlice[];
	/** OpenRouter vs ElevenLabs spend (donut). */
	byProvider: CostSlice[];
	/** Spend per model, top-N with the tail rolled into "Other" (bars). */
	byModel: CostBar[];
	/** Spend per model maker, for the radar (reuses the usage-radar shape). */
	byMaker: AuthorSlice[];
	/** Daily total spend, chronological (oldest → newest), for the sparkline. */
	daily: number[];
}

/** Resolve a stored model id to its maker (label + logo) for the cost radar. */
export type ResolveMaker = (modelId: string) => ResolvedAuthor | null;

// ── Modality palette ─────────────────────────────────────────────────────────
//
// Reuses the History row-kind colors so the pie ties back to the STT/TTS chips
// in the table: speech-to-text blue, text-to-speech orange, and the language
// model in the chart teal (`--color-activity`) that the rest of the dashboard
// already speaks.

const MODALITY_COLOR = {
	stt: "var(--color-history-stt)",
	llm: "var(--color-activity)",
	tts: "var(--color-history-tts)",
} as const;

const OTHER_KEY = "__other__";
/** Beyond this many bars/slices the long tail rolls into one "Other" row. */
const MAX_BARS = 6;
const MAX_SLICES = 6;

// ── Cloud id helpers ─────────────────────────────────────────────────────────

/** Strip the `openrouter:` / `elevenlabs:` cloud prefix for a bare display id. */
function bareModelId(model: string): string {
	return model.replace(/^(?:openrouter|elevenlabs):/, "");
}

/** Provider `{key,label}` behind a stored model id. ElevenLabs models carry the
 *  `elevenlabs:` prefix; everything else (cloud STT/TTS and the LLM path) is
 *  OpenRouter. */
function providerOf(model: string): { key: string; label: string } {
	return model.startsWith("elevenlabs:")
		? { key: "elevenlabs", label: "ElevenLabs" }
		: { key: "openrouter", label: "OpenRouter" };
}

function positiveCost(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function pct(cost: number, total: number): number {
	return total === 0 ? 0 : Math.round((cost / total) * 100);
}

/** Rank-based teal fade matching `UsageBars`, so multi-item cost charts share
 *  one scale: the leading bucket is strongest, each below it steps darker. */
function tealRank(index: number): string {
	const strength = Math.max(40, 70 - index * 14);
	return `color-mix(in oklch, var(--color-activity) ${strength}%, black)`;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

interface Accum {
	cost: number;
	estimate: boolean;
	label: string;
	logoSrc: string | null;
}

function add(
	map: Map<string, Accum>,
	key: string,
	label: string,
	cost: number,
	estimate: boolean,
	logoSrc: string | null = null,
): void {
	const current = map.get(key);
	if (current) {
		current.cost += cost;
		current.estimate = current.estimate || estimate;
	} else {
		map.set(key, { cost, estimate, label, logoSrc });
	}
}

/** One cost component of a run: a stage's spend, the model that produced it, and
 *  whether the figure is an estimate. */
interface CostItem {
	modality: "stt" | "llm" | "tts";
	model: string;
	cost: number;
	estimate: boolean;
}

/** Flatten the filtered history into individual cost components. A single
 *  transcription can contribute up to two (STT decode + LLM cleanup). */
function collectItems(
	entries: TranscriptionHistoryEntry[],
	ttsEntries: TtsHistoryEntry[],
): CostItem[] {
	const items: CostItem[] = [];
	for (const entry of entries) {
		const stt = positiveCost(entry.sttCostUsd);
		if (stt > 0 && entry.sttModel) {
			items.push({
				modality: "stt",
				model: entry.sttModel,
				cost: stt,
				estimate: Boolean(entry.sttCostIsEstimate),
			});
		}
		const llm = positiveCost(entry.llmCostUsd);
		if (llm > 0 && entry.llmModel) {
			// The LLM post-processing path is OpenRouter-only, and its billed
			// figure is provider-reported (never an estimate).
			items.push({
				modality: "llm",
				model: entry.llmModel,
				cost: llm,
				estimate: false,
			});
		}
	}
	for (const run of ttsEntries) {
		const cost = positiveCost(run.costUsd);
		if (cost > 0 && run.model) {
			items.push({
				modality: "tts",
				model: run.model,
				cost,
				estimate: Boolean(run.costIsEstimate),
			});
		}
	}
	return items;
}

function modalitySlices(
	stt: Accum,
	llm: Accum,
	tts: Accum,
	total: number,
): CostSlice[] {
	return [
		{ key: "stt", ...stt, color: MODALITY_COLOR.stt },
		{ key: "llm", ...llm, color: MODALITY_COLOR.llm },
		{ key: "tts", ...tts, color: MODALITY_COLOR.tts },
	]
		.filter((s) => s.cost > 0)
		.sort((a, b) => b.cost - a.cost)
		.map((s) => ({
			key: s.key,
			label: s.label,
			cost: s.cost,
			estimate: s.estimate,
			color: s.color,
			pct: pct(s.cost, total),
		}));
}

function providerSlices(map: Map<string, Accum>, total: number): CostSlice[] {
	return [...map]
		.map(([key, v]) => ({ key, ...v }))
		.sort((a, b) => b.cost - a.cost)
		.map((s, index) => ({
			key: s.key,
			label: s.label,
			cost: s.cost,
			estimate: s.estimate,
			color: tealRank(index),
			pct: pct(s.cost, total),
		}));
}

function modelBars(map: Map<string, Accum>, total: number): CostBar[] {
	const sorted = [...map]
		.map(([key, v]) => ({
			key,
			label: v.label,
			cost: v.cost,
			estimate: v.estimate,
		}))
		.sort((a, b) => b.cost - a.cost);
	if (sorted.length <= MAX_BARS) {
		return sorted.map((b) => ({ ...b, pct: pct(b.cost, total) }));
	}
	const head = sorted.slice(0, MAX_BARS - 1);
	const tail = sorted.slice(MAX_BARS - 1);
	const tailCost = tail.reduce((sum, b) => sum + b.cost, 0);
	const tailEstimate = tail.some((b) => b.estimate);
	return [
		...head.map((b) => ({ ...b, pct: pct(b.cost, total) })),
		{
			key: OTHER_KEY,
			label: OTHER_KEY,
			cost: tailCost,
			estimate: tailEstimate,
			pct: pct(tailCost, total),
		},
	];
}

function makerSlices(
	map: Map<string, Accum>,
	total: number,
	otherLabel: string,
): AuthorSlice[] {
	const sorted = [...map]
		.map(([key, v]) => ({
			key,
			label: v.label,
			logoSrc: v.logoSrc ?? null,
			count: v.cost,
		}))
		.sort((a, b) => b.count - a.count);
	if (sorted.length <= MAX_SLICES) {
		return sorted.map((s) => ({ ...s, pct: pct(s.count, total) }));
	}
	const head = sorted.slice(0, MAX_SLICES - 1);
	const tailCost = sorted
		.slice(MAX_SLICES - 1)
		.reduce((sum, s) => sum + s.count, 0);
	return [
		...head.map((s) => ({ ...s, pct: pct(s.count, total) })),
		{
			key: OTHER_KEY,
			label: otherLabel,
			logoSrc: null,
			count: tailCost,
			pct: pct(tailCost, total),
		},
	];
}

/** Cost per local day across every stage, chronological (oldest → newest). */
function dailyTotals(
	entries: TranscriptionHistoryEntry[],
	ttsEntries: TtsHistoryEntry[],
): number[] {
	const byDay = new Map<string, number>();
	const bump = (timestamp: number, cost: number) => {
		if (cost <= 0) {
			return;
		}
		const key = toDayKey(timestamp);
		byDay.set(key, (byDay.get(key) ?? 0) + cost);
	};
	for (const entry of entries) {
		bump(entry.timestamp, positiveCost(entry.sttCostUsd));
		bump(entry.timestamp, positiveCost(entry.llmCostUsd));
	}
	for (const run of ttsEntries) {
		bump(run.timestamp, positiveCost(run.costUsd));
	}
	return [...byDay.keys()].sort().map((key) => byDay.get(key) ?? 0);
}

export interface CostAnalyticsLabels {
	speechToText: string;
	languageModel: string;
	textToSpeech: string;
	other: string;
}

const EMPTY: CostAnalytics = {
	total: 0,
	estimated: false,
	stt: 0,
	llm: 0,
	tts: 0,
	byModality: [],
	byProvider: [],
	byModel: [],
	byMaker: [],
	daily: [],
};

/**
 * Cost analytics over the (date-filtered) history: how spend splits across
 * modalities, providers, individual models, and makers, plus a daily trend.
 * Pure over the two entry arrays — entries missing cost simply don't count, so
 * every breakdown is empty (and `total === 0`) until there's cloud spend, which
 * is the panel's cue to hide the whole section. Estimated figures (providers
 * that report no billed amount) are flagged so the UI can mark them with `~`.
 */
export function computeCostAnalytics(
	entries: TranscriptionHistoryEntry[],
	ttsEntries: TtsHistoryEntry[],
	resolveMaker: ResolveMaker,
	labels: CostAnalyticsLabels,
): CostAnalytics {
	const items = collectItems(entries, ttsEntries);
	if (items.length === 0) {
		return EMPTY;
	}

	const modalityLabel = {
		stt: labels.speechToText,
		llm: labels.languageModel,
		tts: labels.textToSpeech,
	} as const;
	const modality: Record<"stt" | "llm" | "tts", Accum> = {
		stt: { cost: 0, estimate: false, label: modalityLabel.stt, logoSrc: null },
		llm: { cost: 0, estimate: false, label: modalityLabel.llm, logoSrc: null },
		tts: { cost: 0, estimate: false, label: modalityLabel.tts, logoSrc: null },
	};
	const providers = new Map<string, Accum>();
	const models = new Map<string, Accum>();
	const makers = new Map<string, Accum>();
	let total = 0;
	let estimated = false;

	for (const item of items) {
		total += item.cost;
		estimated = estimated || item.estimate;

		const bucket = modality[item.modality];
		bucket.cost += item.cost;
		bucket.estimate = bucket.estimate || item.estimate;

		const provider = providerOf(item.model);
		add(providers, provider.key, provider.label, item.cost, item.estimate);

		add(models, item.model, bareModelId(item.model), item.cost, item.estimate);

		const resolved = resolveMaker(item.model);
		const makerKey = resolved?.author ?? OTHER_KEY;
		add(
			makers,
			makerKey,
			resolved?.author ?? labels.other,
			item.cost,
			item.estimate,
			resolved?.logoSrc ?? null,
		);
	}

	return {
		total,
		estimated,
		stt: modality.stt.cost,
		llm: modality.llm.cost,
		tts: modality.tts.cost,
		byModality: modalitySlices(modality.stt, modality.llm, modality.tts, total),
		byProvider: providerSlices(providers, total),
		byModel: modelBars(models, total),
		byMaker: makerSlices(makers, total, labels.other),
		daily: dailyTotals(entries, ttsEntries),
	};
}

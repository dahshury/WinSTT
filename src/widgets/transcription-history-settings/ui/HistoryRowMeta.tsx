import {
	AiMicIcon,
	CpuIcon,
	DollarCircleIcon,
	FlashIcon,
	HourglassIcon,
	SquareLock01Icon,
	Tag01Icon,
	VoiceIdIcon,
} from "@hugeicons/core-free-icons";
import {
	bareCloudModelId,
	isCloudModelId,
	modelChipLogo,
} from "@/entities/cloud-stt-provider";
import { findRecommendedModel } from "@/entities/llm-catalog";
import {
	SENSITIVE_HISTORY_LABEL,
	hasPrivacyMarkers,
	historyTagLabel,
} from "@/entities/transcription-history";
import type {
	EntryCardAccent,
	EntryCardMetaPart,
} from "@/shared/ui/entry-card-list";
import {
	formatDuration,
	formatProcessingDuration,
	formatTokensPerSecond,
	formatUsd,
	formatUsdCompact,
	formatWpm,
	wordsPerMinute,
} from "../lib/word-stats";
import type { HistoryTableItem } from "../model/history-table-types";

export interface MetaLabels {
	characters: string;
	cloud: string;
	cost: string;
	costEstimated: string;
	costLanguageModel: string;
	costSpeechToText: string;
	costTextToSpeech: string;
	costTotal: string;
	kindSpeechToText: string;
	kindTextToSpeech: string;
	languageModelProcessing: string;
	notRecorded: string;
	notRun: string;
	recordingDuration: string;
	speed: string;
	speechToTextProcessing: string;
	sttModel: string;
	totalProcessing: string;
	transform: string;
	ttsModel: string;
	voice: string;
	words: string;
	wpm: string;
}

interface DurationBreakdownRow {
	key: string;
	label: string;
	separatorBefore?: boolean;
	value: string;
}

function DurationBreakdownTooltip({ rows }: { rows: DurationBreakdownRow[] }) {
	return (
		<span className="block min-w-32">
			{rows.map((row) => (
				<span
					className={`flex items-center justify-between gap-4 ${
						row.separatorBefore ? "mt-1.5 border-divider border-t pt-1.5" : ""
					}`}
					key={row.key}
				>
					{/* secondary, not muted — muted (55% L) sinks into the surface-7 popup */}
					<span className="text-foreground-secondary">{row.label}</span>
					<span className="font-medium text-foreground tabular-nums">
						{row.value}
					</span>
				</span>
			))}
		</span>
	);
}

function positiveDurationMs(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function formatOptionalProcessingDuration(
	value: number | undefined,
	fallback: string,
): string {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return formatProcessingDuration(value) ?? fallback;
}

/** Whether a post-processing (LLM) model ran on a cloud provider. Unlike
 *  STT/TTS ids it carries no cloud prefix — the OpenRouter path uses a
 *  `vendor/model` id (Ollama uses `name:tag`, never a slash) and reports a
 *  billed `llmCostUsd`, so either marks it as cloud. */
function isCloudLlm(model: string, costUsd: number | undefined): boolean {
	const directHuggingFacePull = bareCloudModelId(model)
		.toLowerCase()
		.startsWith("hf.co/");
	return (
		isCloudModelId(model) ||
		(!directHuggingFacePull && model.includes("/")) ||
		Number.isFinite(costUsd)
	);
}

interface CostBreakdownPart {
	estimate: boolean;
	key: string;
	label: string;
	value: number | undefined;
}

interface CostExtraRow {
	key: string;
	label: string;
	value: string;
}

/**
 * Build the footer's cloud-cost chip from the run's per-stage costs. The chip
 * shows the run total; the tooltip breaks it down per stage. Estimated figures
 * (providers that report no billed amount) are marked with "~". `null` when
 * the run billed nothing (fully local).
 */
function buildCostChip(
	labels: MetaLabels,
	parts: CostBreakdownPart[],
	extraRows: CostExtraRow[] = [],
): EntryCardMetaPart | null {
	const present = parts.filter(
		(part): part is CostBreakdownPart & { value: number } =>
			typeof part.value === "number" &&
			Number.isFinite(part.value) &&
			part.value >= 0,
	);
	if (present.length === 0) {
		return null;
	}
	const total = present.reduce((sum, part) => sum + part.value, 0);
	// The chip shows a trimmed approximation so the strip stays one line; the
	// tooltip carries the exact per-stage figures (full-precision `formatUsd`).
	const compactTotal = formatUsdCompact(total);
	const exactTotal = formatUsd(total);
	if (!(compactTotal && exactTotal)) {
		return null;
	}
	const anyEstimate = present.some((part) => part.estimate);
	const rows = present.map((part) => ({
		key: part.key,
		label: part.estimate
			? `${part.label} (${labels.costEstimated})`
			: part.label,
		value: `${part.estimate ? "~" : ""}${formatUsd(part.value) ?? ""}`,
	}));
	// Always surface an exact total so hovering the approximate chip reveals the
	// precise amount, even for a single-stage run.
	rows.push({
		key: "total",
		label: labels.costTotal,
		value: `${anyEstimate ? "~" : ""}${exactTotal}`,
	});
	rows.push(...extraRows);
	return {
		icon: DollarCircleIcon,
		key: "cost",
		title: labels.cost,
		tooltip: <DurationBreakdownTooltip rows={rows} />,
		value: `${anyEstimate ? "~" : ""}${compactTotal}`,
	};
}

/**
 * Build a history row's card accent (the tinted edge rail typing the whole
 * card) and its footer meta strip (icon + bare value chips, in pipeline order:
 * processing, model chips, cost). Split out of `HistoryRow`
 * so the row component stays focused on playback state and layout.
 */
export function buildHistoryRowMeta(
	item: HistoryTableItem,
	labels: MetaLabels,
): { accent: EntryCardAccent; meta: EntryCardMetaPart[] } {
	const { entry, kind, tts } = item;
	const showAudioStats = kind === "transcription";
	const wpm = showAudioStats
		? wordsPerMinute(entry.wordCount, entry.durationMs)
		: 0;
	// Icon + bare value, reusing the summary tiles' stat icons (words / duration
	// / wpm) so a row reads as part of the same family. Dropping the inline text
	// labels keeps the strip on ONE line; the icon + hover title carry meaning.
	// Optional parts (wpm, the LLM trio) drop out cleanly when absent. `logo`
	// swaps the glyph for a maker brand mark (the model chip).
	const meta: EntryCardMetaPart[] = [];
	// Kind identity lives on the CARD, not the footer: a tinted edge rail (blue
	// mic vs orange voice vs accent transform) types the whole card and matches
	// the body-side kind bubble, so the meta strip carries data only. Playable
	// STT rows — whose bubble slot is taken by the play button — still read as
	// STT through the rail.
	const accent: EntryCardAccent =
		kind === "tts"
			? { label: labels.kindTextToSpeech, railClass: "bg-history-tts" }
			: kind === "transform"
				? { label: labels.transform, railClass: "bg-accent" }
				: { label: labels.kindSpeechToText, railClass: "bg-history-stt" };
	// Content classification tag (Document / Note / AI Prompt …) and the sensitive
	// marker lead the strip. They used to sit as pill badges in the card's
	// top-right column, whose `shrink-0` width stole horizontal space from the
	// transcript; as leading footer chips they stay visible without narrowing the
	// text or growing the card.
	const tagLabel = historyTagLabel(entry.historyTag);
	if (tagLabel) {
		meta.push({
			icon: Tag01Icon,
			key: "tag",
			value: tagLabel,
		});
	}
	if (hasPrivacyMarkers(entry.privacyMarkers)) {
		meta.push({
			icon: SquareLock01Icon,
			key: "sensitive",
			value: SENSITIVE_HISTORY_LABEL,
		});
	}
	if (showAudioStats) {
		const sttProcessingMs = positiveDurationMs(entry.sttProcessingMs);
		const llmProcessingMs = positiveDurationMs(entry.llmProcessingMs);
		const processingTotal = formatProcessingDuration(
			sttProcessingMs + llmProcessingMs,
		);
		if (processingTotal) {
			const timingRows: DurationBreakdownRow[] = [
				{
					key: "recording",
					label: labels.recordingDuration,
					value:
						entry.durationMs > 0
							? formatDuration(entry.durationMs)
							: labels.notRecorded,
				},
				{
					key: "stt",
					label: labels.speechToTextProcessing,
					value: formatOptionalProcessingDuration(
						entry.sttProcessingMs,
						labels.notRecorded,
					),
				},
				{
					key: "llm",
					label: labels.languageModelProcessing,
					value: formatOptionalProcessingDuration(
						entry.llmProcessingMs,
						labels.notRun,
					),
				},
			];
			timingRows.push({
				key: "words",
				label: labels.words,
				separatorBefore: true,
				value: String(entry.wordCount),
			});
			if (wpm > 0) {
				timingRows.push({
					key: "wpm",
					label: labels.wpm,
					value: formatWpm(wpm),
				});
			}
			meta.push({
				icon: HourglassIcon,
				key: "processing-total",
				title: labels.totalProcessing,
				tooltip: <DurationBreakdownTooltip rows={timingRows} />,
				value: processingTotal,
			});
		}
	}
	// Which STT ("main") model produced this transcription. Sits before the LLM
	// trio so the strip reads in pipeline order: speech→text, then text cleanup.
	// The title carries the label so the AiMic glyph isn't mistaken for the LLM
	// model chip below.
	if (entry.sttModel) {
		const bareStt = bareCloudModelId(entry.sttModel);
		meta.push({
			cloud: isCloudModelId(entry.sttModel),
			cloudLabel: labels.cloud,
			icon: AiMicIcon,
			key: "stt-model",
			logo: modelChipLogo(entry.sttModel),
			monoLogo: true,
			title: `${labels.sttModel}: ${bareStt}`,
			truncate: true,
			value: bareStt,
		});
	}
	// LLM post-processing telemetry stays at the end of the strip. Transcription
	// rows fold processing time into the duration chip above; transform rows have
	// no audio duration, so they keep the processing-time chip here.
	if (entry.llmModel) {
		const llmError = entry.llmError?.trim();
		const bareLlm = bareCloudModelId(entry.llmModel);
		const displayLlm = findRecommendedModel(bareLlm)?.displayName ?? bareLlm;
		// Title carries the full model id so truncation stays inspectable on hover.
		// When the cleanup fail-softed, keep the model visible but mark it as failed.
		meta.push({
			cloud: isCloudLlm(entry.llmModel, entry.llmCostUsd),
			cloudLabel: labels.cloud,
			danger: Boolean(llmError),
			icon: CpuIcon,
			key: "model",
			logo: modelChipLogo(entry.llmModel),
			monoLogo: true,
			title: llmError
				? `${bareLlm}\nPost-processing failed: ${llmError}`
				: bareLlm,
			truncate: true,
			value: displayLlm,
		});
	}
	const processing =
		entry.llmProcessingMs === undefined
			? null
			: formatProcessingDuration(entry.llmProcessingMs);
	if (processing && !showAudioStats) {
		meta.push({
			icon: HourglassIcon,
			key: "processing",
			title: labels.languageModelProcessing,
			tooltip: (
				<DurationBreakdownTooltip
					rows={[
						{
							key: "llm",
							label: labels.languageModelProcessing,
							value: processing,
						},
					]}
				/>
			),
			value: processing,
		});
	}
	const speed =
		entry.llmTokensPerSecond === undefined
			? null
			: formatTokensPerSecond(entry.llmTokensPerSecond);
	if (speed) {
		meta.push({
			icon: FlashIcon,
			key: "speed",
			title: labels.speed,
			value: speed,
		});
	}
	// TTS-run chips: synthesis time, voice model (with maker logo), and voice.
	if (kind === "tts" && tts) {
		const ttsProcessing = formatProcessingDuration(tts.processingMs ?? 0);
		if (ttsProcessing) {
			meta.push({
				icon: HourglassIcon,
				key: "processing-total",
				title: labels.totalProcessing,
				value: ttsProcessing,
			});
		}
		const bareModel = bareCloudModelId(tts.model);
		if (bareModel) {
			meta.push({
				cloud: isCloudModelId(tts.model),
				cloudLabel: labels.cloud,
				icon: CpuIcon,
				key: "tts-model",
				logo: modelChipLogo(tts.model),
				monoLogo: true,
				title: `${labels.ttsModel}: ${bareModel}`,
				truncate: true,
				value: bareModel,
			});
		}
		if (tts.voice) {
			meta.push({
				icon: VoiceIdIcon,
				key: "voice",
				title: labels.voice,
				truncate: true,
				value: tts.voice,
			});
		}
	}
	// Cloud cost chip — the run's billed USD with a per-stage breakdown on
	// hover. Absent for fully local runs (nothing billed).
	const costChip =
		kind === "tts" && tts
			? buildCostChip(
					labels,
					[
						{
							estimate: Boolean(tts.costIsEstimate),
							key: "tts",
							label: labels.costTextToSpeech,
							value: tts.costUsd,
						},
					],
					[
						{
							key: "characters",
							label: labels.characters,
							value: String(tts.characters),
						},
					],
				)
			: buildCostChip(labels, [
					{
						estimate: Boolean(entry.sttCostIsEstimate),
						key: "stt",
						label: labels.costSpeechToText,
						value: entry.sttCostUsd,
					},
					{
						estimate: false,
						key: "llm",
						label: labels.costLanguageModel,
						value: entry.llmCostUsd,
					},
				]);
	if (costChip) {
		meta.push(costChip);
	}
	return { accent, meta };
}

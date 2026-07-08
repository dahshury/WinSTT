import {
	AiEditingIcon,
	AiMicIcon,
	AiVoiceIcon,
	Clock01Icon,
	CpuIcon,
	DashboardSpeed02Icon,
	DollarCircleIcon,
	FlashIcon,
	HourglassIcon,
	TextFontIcon,
	VoiceIdIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { VList } from "virtua";
import {
	bareCloudModelId,
	isCloudModelId,
	modelChipLogo,
} from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import {
	SENSITIVE_HISTORY_LABEL,
	hasPrivacyMarkers,
	historyTagLabel,
} from "@/entities/transcription-history";
import {
	deleteTranscriptionHistoryEntry,
	deleteTransformHistoryEntry,
	deleteTtsHistoryEntry,
} from "@/shared/api/ipc-client";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import { formatTime } from "@/shared/lib/format-time";
import { useSpeechActivityRef } from "@/shared/lib/use-speech-activity-ref";
import { Badge } from "@/shared/ui/badge";
import { ButtonGroup } from "@/shared/ui/button-group";
import {
	EntryCard,
	type EntryCardMetaPart,
	EntryCardShell,
} from "@/shared/ui/entry-card-list";
import { MediaSeekBar } from "@/shared/ui/media-seek-bar";
import { StaggerReveal } from "@/shared/ui/stagger-reveal";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	formatDuration,
	formatProcessingDuration,
	formatTokensPerSecond,
	formatUsd,
	formatUsdCompact,
	formatWpm,
	wordsPerMinute,
} from "../lib/word-stats";
import { getEntryTranscriptDiff } from "../lib/transcript-diff-cache";
import { useHistoryPlayback } from "../model/use-history-playback";
import type {
	TranscriptionHistoryEntry,
	TtsHistoryEntry,
} from "../model/history-store";
import {
	CopyButton,
	DeleteButton,
	PlayButton,
	SwapButton,
} from "./HistoryRowButtons";
import { RowTranscript } from "./RowTranscript";

export type HistoryTableEntryKind = "transcription" | "transform" | "tts";

export interface HistoryTableItem {
	entry: TranscriptionHistoryEntry;
	kind: HistoryTableEntryKind;
	/** The originating read-aloud run — present only when `kind === "tts"`. */
	tts?: TtsHistoryEntry;
}

interface HistoryTableProps {
	emptyLabel?: string;
	entries: HistoryTableItem[];
	onDeleteEntry?: (id: string, kind: HistoryTableEntryKind) => void;
}

// Initial size estimate only — virtua re-measures every mounted row, so rows
// whose transcripts wrap to several lines self-correct. A short transcript card
// (body + recessed meta shelf) plus its inter-card padding lands around here.
const ROW_HEIGHT_HINT_PX = 120;
// Cap the visible body so the table doesn't crowd out the rest of the panel;
// anything beyond this scrolls. Generous so the transcription list reads as a
// roomy, dedicated scroll region rather than a cramped box; the body
// deliberately omits `overscroll-contain` so reaching either end chains the
// wheel to the page's ScrollArea instead of trapping the scroll.
const MAX_BODY_HEIGHT_PX = 560;
// Below this row count, render directly (cheaper than VList's bookkeeping);
// at/above it, virtualize so the mounted-row count stays bounded.
const VIRTUALIZE_THRESHOLD = 50;

function formatTimestamp(ms: number): string {
	// Abbreviated on purpose — the year is dropped and the hour is non-padded so
	// the whole meta strip fits one line in the ~500px-wide settings panel.
	return new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function historyItemKey(item: HistoryTableItem): string {
	return `${item.kind}:${item.entry.id}`;
}

interface HistoryRowProps {
	copyLabel: string;
	item: HistoryTableItem;
}

interface MetaLabels {
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
	time: string;
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
	value: string;
}

function DurationBreakdownTooltip({ rows }: { rows: DurationBreakdownRow[] }) {
	return (
		<span className="block min-w-32">
			{rows.map((row) => (
				<span className="flex items-center justify-between gap-4" key={row.key}>
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
	return (
		isCloudModelId(model) || model.includes("/") || Number.isFinite(costUsd)
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

interface HistoryRowFullProps extends HistoryRowProps {
	labels: MetaLabels;
	onDeleteEntry: (id: string, kind: HistoryTableEntryKind) => void;
	outputDeviceId: string;
	viewFullLabel: string;
	viewOriginalLabel: string;
	viewProcessedLabel: string;
}

function HistoryRow({
	copyLabel,
	item,
	labels,
	onDeleteEntry,
	outputDeviceId,
	viewFullLabel,
	viewOriginalLabel,
	viewProcessedLabel,
}: HistoryRowFullProps) {
	const { entry, kind, tts } = item;
	const hasPlayableAudio =
		kind === "transcription" && Boolean(entry.audioFilePath);
	const playback = useHistoryPlayback(
		entry.id,
		hasPlayableAudio,
		outputDeviceId,
	);
	const transcriptDiff = getEntryTranscriptDiff(entry);
	const hasOriginal = transcriptDiff !== null;
	// Per-row view toggle for LLM-processed entries; resets implicitly because
	// each row is keyed by entry.id. Defaults to the AI-edited final text.
	const [showOriginal, setShowOriginal] = useState(false);
	const displayText =
		showOriginal && entry.originalText ? entry.originalText : entry.text;
	// The word-highlight + seek bar belong to the RAW spoken transcript (that's
	// what the timings align to). For an LLM-processed entry they live in the
	// "original" view; entries with no AI text have no swap and always show them
	// once played. Swapping back to the AI text therefore EXITS the playback view
	// — the fix for the swap button appearing dead during playback.
	const inOriginalView = !hasOriginal || showOriginal;
	const playbackViewActive = playback.hasStarted && inOriginalView;
	const handlePlaybackToggle = () => {
		if (!playback.playing && hasOriginal) {
			setShowOriginal(true);
		}
		playback.toggle();
	};
	const handleSwapToggle = () => {
		const next = !showOriginal;
		// Returning to the AI-text (non-playback) view: pause so audio doesn't keep
		// running under a view with no highlight or scrubber.
		if (!next && playback.playing) {
			playback.toggle();
		}
		setShowOriginal(next);
	};
	const tagLabel = historyTagLabel(entry.historyTag);
	const sensitive = hasPrivacyMarkers(entry.privacyMarkers);
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
	// Kind chip: STT and TTS runs share one table, so each row leads with a
	// tinted kind marker (blue mic vs orange voice) that scans apart at a
	// glance. Transform rows keep their body-side accent bubble instead.
	if (kind === "transcription") {
		meta.push({
			icon: AiMicIcon,
			key: "kind",
			tint: "text-history-stt",
			title: labels.kindSpeechToText,
			value: "STT",
		});
	} else if (kind === "tts") {
		meta.push({
			icon: AiVoiceIcon,
			key: "kind",
			tint: "text-history-tts",
			title: labels.kindTextToSpeech,
			value: "TTS",
		});
	}
	meta.push(
		{
			icon: Clock01Icon,
			key: "time",
			title: labels.time,
			value: formatTimestamp(entry.timestamp),
		},
		{
			icon: TextFontIcon,
			key: "words",
			title: labels.words,
			value: String(entry.wordCount),
		},
	);
	if (showAudioStats) {
		const sttProcessingMs = positiveDurationMs(entry.sttProcessingMs);
		const llmProcessingMs = positiveDurationMs(entry.llmProcessingMs);
		const processingTotal = formatProcessingDuration(
			sttProcessingMs + llmProcessingMs,
		);
		if (processingTotal) {
			meta.push({
				icon: HourglassIcon,
				key: "processing-total",
				title: labels.totalProcessing,
				tooltip: (
					<DurationBreakdownTooltip
						rows={[
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
						]}
					/>
				),
				value: processingTotal,
			});
		}
	}
	if (wpm > 0) {
		meta.push({
			icon: DashboardSpeed02Icon,
			key: "wpm",
			title: labels.wpm,
			value: formatWpm(wpm),
		});
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
			value: bareLlm,
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
	return (
		<EntryCard footer={meta} singleLine>
			<div className="flex items-start gap-3">
				{kind === "transform" ? (
					<Tooltip content={labels.transform} side="top">
						<span
							aria-label={labels.transform}
							className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent"
							role="img"
						>
							<HugeiconsIcon className="size-3.5" icon={AiEditingIcon} />
						</span>
					</Tooltip>
				) : kind === "tts" ? (
					<Tooltip content={labels.kindTextToSpeech} side="top">
						<span
							aria-label={labels.kindTextToSpeech}
							className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-history-tts/10 text-history-tts"
							role="img"
						>
							<HugeiconsIcon className="size-3.5" icon={AiVoiceIcon} />
						</span>
					</Tooltip>
				) : hasPlayableAudio ? (
					<PlayButton
						loading={playback.loading}
						onToggle={handlePlaybackToggle}
						playing={playback.playing}
					/>
				) : (
					<Tooltip content={labels.kindSpeechToText} side="top">
						<span
							aria-label={labels.kindSpeechToText}
							className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-history-stt/10 text-history-stt"
							role="img"
						>
							<HugeiconsIcon className="size-3.5" icon={AiMicIcon} />
						</span>
					</Tooltip>
				)}
				<RowTranscript
					activeIndex={playback.activeIndex}
					diff={transcriptDiff}
					displayText={displayText}
					onSeekWord={
						hasPlayableAudio
							? (index) => {
									const word = playback.words?.[index];
									if (word) {
										playback.seek(word.start);
									}
								}
							: undefined
					}
					viewFullLabel={viewFullLabel}
					words={playbackViewActive ? playback.words : null}
				/>
				<div className="flex shrink-0 flex-col items-end gap-2 self-start">
					<div className="flex max-w-[8rem] flex-wrap justify-end gap-1">
						{tagLabel ? <Badge variant="secondary">{tagLabel}</Badge> : null}
						{sensitive ? (
							<Badge variant="outline">{SENSITIVE_HISTORY_LABEL}</Badge>
						) : null}
					</div>
					<ButtonGroup
						aria-label={copyLabel}
						className="shrink-0"
						connected
						orientation="vertical"
						separator="inset-strong"
					>
						{hasOriginal ? (
							<SwapButton
								onToggle={handleSwapToggle}
								showOriginal={showOriginal}
								showOriginalLabel={viewOriginalLabel}
								showProcessedLabel={viewProcessedLabel}
							/>
						) : null}
						<CopyButton label={copyLabel} text={displayText} />
						<DeleteButton
							entryId={entry.id}
							onDelete={(id) => onDeleteEntry(id, kind)}
						/>
					</ButtonGroup>
				</div>
			</div>
			{/* Media scrubber — the same island seek bar (tone="surface"), revealed
			    once playback starts and kept visible when paused so the user can
			    scrub, resume, or click a word above to jump. Sits just above the
			    card's footer shelf. */}
			{hasPlayableAudio && playbackViewActive ? (
				<div className="flex items-center gap-2 text-[10px] text-foreground-muted">
					<span className="w-9 shrink-0 text-right font-mono tabular-nums">
						{formatTime(playback.currentTime * 1000)}
					</span>
					<MediaSeekBar
						bufferedEnd={playback.duration}
						className="flex-1"
						currentTime={playback.currentTime}
						duration={playback.duration}
						onSeek={playback.seek}
						tone="surface"
					/>
					<span className="w-9 shrink-0 font-mono tabular-nums">
						{formatTime(playback.duration * 1000)}
					</span>
				</div>
			) : null}
		</EntryCard>
	);
}

export function HistoryTable({
	emptyLabel,
	entries,
	onDeleteEntry,
}: HistoryTableProps) {
	const t = useTranslations("history");
	const outputDeviceId = useSettingsStore(
		(s) => s.settings.general.outputDeviceId,
	);
	const [animatedEntryKeys, setAnimatedEntryKeys] = useState<Set<string>>(
		() => new Set(),
	);
	const previousEntryKeysRef = useRef<Set<string> | null>(null);
	const speechActivityRef = useSpeechActivityRef();
	const copyLabel = t("copy");
	const viewFullLabel = t("viewFull");
	const viewOriginalLabel = t("viewOriginal");
	const viewProcessedLabel = t("viewProcessed");
	const deleteEntry: (id: string, kind: HistoryTableEntryKind) => void =
		onDeleteEntry ??
		((id, kind) => {
			if (kind === "transform") {
				fireAndForget(
					deleteTransformHistoryEntry(id),
					"history.deleteTransform",
				);
				return;
			}
			if (kind === "tts") {
				fireAndForget(deleteTtsHistoryEntry(id), "history.deleteTts");
				return;
			}
			fireAndForget(deleteTranscriptionHistoryEntry(id), "history.deleteEntry");
		});
	const labels: MetaLabels = {
		characters: t("colCharacters"),
		cloud: t("cloudLabel"),
		cost: t("colCost"),
		costEstimated: t("costEstimated"),
		costLanguageModel: t("costLanguageModel"),
		costSpeechToText: t("costSpeechToText"),
		costTextToSpeech: t("costTextToSpeech"),
		costTotal: t("costTotal"),
		kindSpeechToText: t("kindSpeechToText"),
		kindTextToSpeech: t("kindTextToSpeech"),
		languageModelProcessing: t("durationLlmProcessing"),
		notRecorded: t("durationNotRecorded"),
		notRun: t("durationNotRun"),
		recordingDuration: t("durationRecording"),
		speed: t("colSpeed"),
		speechToTextProcessing: t("durationSpeechToText"),
		sttModel: t("colSttModel"),
		time: t("colTime"),
		totalProcessing: t("durationTotalProcessing"),
		transform: t("transformTableTitle"),
		ttsModel: t("colTtsModel"),
		voice: t("colVoice"),
		wpm: t("colWpm"),
		words: t("colWords"),
	};

	const sorted = useMemo(
		() =>
			entries
				.map((item, index) => ({ index, item }))
				.sort(
					(a, b) =>
						b.item.entry.timestamp - a.item.entry.timestamp ||
						b.index - a.index,
				)
				.map(({ item }) => item),
		[entries],
	);

	useLayoutEffect(() => {
		const nextKeys = new Set(sorted.map(historyItemKey));
		const previousKeys = previousEntryKeysRef.current;
		if (previousKeys && speechActivityRef.current) {
			const addedKeys = [...nextKeys].filter((key) => !previousKeys.has(key));
			if (addedKeys.length > 0) {
				setAnimatedEntryKeys((current) => {
					const next = new Set(current);
					for (const key of addedKeys) {
						next.add(key);
					}
					return next;
				});
			}
		}
		previousEntryKeysRef.current = nextKeys;
	}, [sorted, speechActivityRef]);

	const renderRow = (item: HistoryTableItem) => {
		const key = historyItemKey(item);
		return (
			<StaggerReveal
				active={animatedEntryKeys.has(key)}
				key={key}
				onComplete={() =>
					setAnimatedEntryKeys((current) => {
						if (!current.has(key)) {
							return current;
						}
						const next = new Set(current);
						next.delete(key);
						return next;
					})
				}
			>
				<HistoryRow
					copyLabel={copyLabel}
					item={item}
					labels={labels}
					onDeleteEntry={deleteEntry}
					outputDeviceId={outputDeviceId}
					viewFullLabel={viewFullLabel}
					viewOriginalLabel={viewOriginalLabel}
					viewProcessedLabel={viewProcessedLabel}
				/>
			</StaggerReveal>
		);
	};

	let body: React.ReactNode;
	if (sorted.length === 0) {
		body = (
			<div className="px-3 py-6 text-center text-body-sm text-foreground-muted">
				{emptyLabel ?? t("tableEmpty")}
			</div>
		);
	} else if (sorted.length < VIRTUALIZE_THRESHOLD) {
		body = (
			<div
				className="overflow-y-auto"
				style={{
					maxHeight: MAX_BODY_HEIGHT_PX,
					scrollbarGutter: "stable both-edges",
					touchAction: "pan-y",
					WebkitOverflowScrolling: "touch",
				}}
			>
				{sorted.map(renderRow)}
			</div>
		);
	} else {
		body = (
			<VList
				data={sorted}
				itemSize={ROW_HEIGHT_HINT_PX}
				style={{
					height: Math.min(
						sorted.length * ROW_HEIGHT_HINT_PX,
						MAX_BODY_HEIGHT_PX,
					),
					scrollbarGutter: "stable both-edges",
					touchAction: "pan-y",
					WebkitOverflowScrolling: "touch",
				}}
			>
				{renderRow}
			</VList>
		);
	}

	// `bare`: the table sits inside a `boxed` section card, which is the single
	// surface — a painted shell here would nest a second background.
	return <EntryCardShell bare>{body}</EntryCardShell>;
}

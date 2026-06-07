import {
	AiMicIcon,
	Clock01Icon,
	CpuIcon,
	DashboardSpeed02Icon,
	FlashIcon,
	HourglassIcon,
	StopWatchIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { VList } from "virtua";
import { useSettingsStore } from "@/entities/setting";
import {
	SENSITIVE_HISTORY_LABEL,
	hasPrivacyMarkers,
	historyTagLabel,
} from "@/entities/transcription-history";
import { deleteTranscriptionHistoryEntry } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import {
	makerFromModelId,
	resolveProviderIcon,
} from "@/shared/lib/provider-icons";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { buildTranscriptDiff } from "@/shared/lib/transcript-diff";
import { ButtonGroup } from "@/shared/ui/button-group";
import { Badge } from "@/shared/ui/badge";
import {
	formatDuration,
	formatProcessingDuration,
	formatTokensPerSecond,
	formatWpm,
	wordsPerMinute,
} from "../lib/word-stats";
import { useHistoryPlayback } from "../model/use-history-playback";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import {
	CopyButton,
	DeleteButton,
	PlayButton,
	SwapButton,
} from "./HistoryRowButtons";
import { RowTranscript } from "./RowTranscript";

interface HistoryTableProps {
	emptyLabel?: string;
	entries: TranscriptionHistoryEntry[];
	onDeleteEntry?: (id: string) => void;
	showAudioStats?: boolean;
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

interface HistoryRowProps {
	copyLabel: string;
	entry: TranscriptionHistoryEntry;
}

interface MetaLabels {
	duration: string;
	model: string;
	processing: string;
	speed: string;
	sttModel: string;
	time: string;
	words: string;
	wpm: string;
}

interface HistoryRowFullProps extends HistoryRowProps {
	labels: MetaLabels;
	onDeleteEntry: (id: string) => void;
	outputDeviceId: string;
	showAudioStats: boolean;
	viewFullLabel: string;
	viewOriginalLabel: string;
	viewProcessedLabel: string;
}

function HistoryRow({
	entry,
	copyLabel,
	labels,
	onDeleteEntry,
	outputDeviceId,
	showAudioStats,
	viewFullLabel,
	viewOriginalLabel,
	viewProcessedLabel,
}: HistoryRowFullProps) {
	const playback = useHistoryPlayback(
		entry.id,
		Boolean(entry.audioFilePath),
		outputDeviceId,
	);
	const transcriptDiff =
		typeof entry.originalText === "string"
			? buildTranscriptDiff(entry.originalText, entry.text)
			: null;
	const hasOriginal = transcriptDiff !== null;
	// Each entry is its own elevated card, one surface step above the list it sits
	// in (FF surfaces: substrate flows through context, lift +1). The meta footer
	// then recesses BACK to the list surface (`cardLevel - 1`) so it reads as a
	// distinct ledge under the card body — the STT model card's recessed-shelf idea.
	const cardLevel = Math.min(useSurface() + 1, 8);
	// Per-row view toggle for LLM-processed entries; resets implicitly because
	// each row is keyed by entry.id. Defaults to the AI-edited final text.
	const [showOriginal, setShowOriginal] = useState(false);
	const displayText =
		showOriginal && entry.originalText ? entry.originalText : entry.text;
	const handlePlaybackToggle = () => {
		if (!playback.playing && hasOriginal) {
			setShowOriginal(true);
		}
		playback.toggle();
	};
	const tagLabel = historyTagLabel(entry.historyTag);
	const sensitive = hasPrivacyMarkers(entry.privacyMarkers);
	const wpm = showAudioStats
		? wordsPerMinute(entry.wordCount, entry.durationMs)
		: 0;
	// Icon + bare value, reusing the summary tiles' stat icons (words / duration
	// / wpm) so a row reads as part of the same family. Dropping the inline text
	// labels keeps the strip on ONE line; the icon + hover title carry meaning.
	// Optional parts (wpm, the LLM trio) drop out cleanly when absent. `logo`
	// swaps the glyph for a maker brand mark (the model chip).
	const meta: {
		icon: IconSvgElement;
		key: string;
		logo?: string | null;
		title: string;
		truncate?: boolean;
		value: string;
	}[] = [
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
	];
	if (showAudioStats) {
		meta.push({
			icon: StopWatchIcon,
			key: "duration",
			title: labels.duration,
			value: formatDuration(entry.durationMs),
		});
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
		meta.push({
			icon: AiMicIcon,
			key: "stt-model",
			title: `${labels.sttModel}: ${entry.sttModel}`,
			truncate: true,
			value: entry.sttModel,
		});
	}
	// LLM post-processing telemetry, grouped at the end of the strip: which model
	// (branded with its maker logo when one is bundled, else the CPU glyph), how
	// long the pass took, and its generation speed. Each chip is independent —
	// e.g. tokens/s drops out when the provider reported no usage.
	if (entry.llmModel) {
		// Title carries the full model id so truncation stays inspectable on hover.
		meta.push({
			icon: CpuIcon,
			key: "model",
			logo: resolveProviderIcon(makerFromModelId(entry.llmModel)),
			title: entry.llmModel,
			truncate: true,
			value: entry.llmModel,
		});
	}
	const processing =
		entry.llmProcessingMs !== undefined
			? formatProcessingDuration(entry.llmProcessingMs)
			: null;
	if (processing) {
		meta.push({
			icon: HourglassIcon,
			key: "processing",
			title: labels.processing,
			value: processing,
		});
	}
	const speed =
		entry.llmTokensPerSecond !== undefined
			? formatTokensPerSecond(entry.llmTokensPerSecond)
			: null;
	if (speed) {
		meta.push({
			icon: FlashIcon,
			key: "speed",
			title: labels.speed,
			value: speed,
		});
	}
	return (
		// Per-card padding wrapper: virtua measures the border-box (margins are
		// NOT counted), so the inter-card gap lives here as padding, never as a
		// margin on the card itself. Horizontal inset is deliberately omitted —
		// the scroll container reserves a symmetric `scrollbar-gutter` on both
		// edges, so the side gaps match (left == right) instead of the right
		// being padding + the scrollbar's reserved width.
		<div className="py-1">
			<SurfaceProvider value={cardLevel}>
				<div
					className={cn(
						"flex flex-col gap-2.5 overflow-hidden rounded-xl border border-border px-3.5 py-3",
						surfaceClasses(cardLevel, Math.max(cardLevel - 1, 1)),
						"transition-colors duration-150",
						surfaceHoverBg(Math.min(cardLevel + 1, 8)),
						"hover:border-border-hover",
					)}
				>
					<div className="flex items-start gap-3">
						{entry.audioFilePath ? (
							<PlayButton
								loading={playback.loading}
								onToggle={handlePlaybackToggle}
								playing={playback.playing}
							/>
						) : null}
						<RowTranscript
							activeIndex={playback.activeIndex}
							diff={transcriptDiff}
							displayText={displayText}
							viewFullLabel={viewFullLabel}
							words={playback.words}
						/>
						<div className="flex shrink-0 flex-col items-end gap-2 self-start">
							<div className="flex max-w-[8rem] flex-wrap justify-end gap-1">
								{tagLabel ? (
									<Badge variant="secondary">{tagLabel}</Badge>
								) : null}
								{sensitive ? (
									<Badge variant="outline">{SENSITIVE_HISTORY_LABEL}</Badge>
								) : null}
							</div>
							<ButtonGroup
								aria-label={copyLabel}
								className="shrink-0"
								connected
								orientation="vertical"
							>
								{hasOriginal ? (
									<SwapButton
										onToggle={() => setShowOriginal((prev) => !prev)}
										showOriginal={showOriginal}
										showOriginalLabel={viewOriginalLabel}
										showProcessedLabel={viewProcessedLabel}
									/>
								) : null}
								<CopyButton label={copyLabel} text={displayText} />
								<DeleteButton entryId={entry.id} onDelete={onDeleteEntry} />
							</ButtonGroup>
						</div>
					</div>
					{/* Recessed meta shelf: full-bleed to the card's bottom + side edges
					    (negative margins MUST match the card's px-3.5/py-3), split off by a
					    hairline, and stepped DOWN one surface so it reads as a ledge. */}
					<div
						className={cn(
							"-mx-3.5 -mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-divider border-t px-3.5 pt-2.5 pb-3 text-foreground-secondary text-xs-tight",
							surfaceBg(Math.max(cardLevel - 1, 1)),
						)}
					>
						{meta.map((part) => (
							<span
								className="inline-flex min-w-0 items-center gap-1 tabular-nums"
								key={part.key}
								title={part.title}
							>
								{part.logo ? (
									<img
										alt=""
										aria-hidden="true"
										className="size-3.5 shrink-0 rounded-[3px] object-contain"
										src={part.logo}
									/>
								) : (
									<HugeiconsIcon
										aria-hidden="true"
										className="size-3.5 shrink-0 text-foreground-muted"
										icon={part.icon}
										strokeWidth={1.75}
									/>
								)}
								<span
									className={
										part.truncate
											? "max-w-[10rem] truncate"
											: "whitespace-nowrap"
									}
								>
									{part.value}
								</span>
							</span>
						))}
					</div>
				</div>
			</SurfaceProvider>
		</div>
	);
}

export function HistoryTable({
	emptyLabel,
	entries,
	onDeleteEntry,
	showAudioStats = true,
}: HistoryTableProps) {
	const t = useTranslations("history");
	const outputDeviceId = useSettingsStore(
		(s) => s.settings.general.outputDeviceId,
	);
	// Lift the table one surface step above the section it sits in so the card
	// reads as its own surface, and re-provide that level so rows + the action
	// button-group elevate from here (surfaces system — no flat tokens).
	const level = Math.min(useSurface() + 1, 8);
	// Most recent first; entries are stored chronologically by the main process.
	const sorted = [...entries].reverse();
	const copyLabel = t("copy");
	const viewFullLabel = t("viewFull");
	const viewOriginalLabel = t("viewOriginal");
	const viewProcessedLabel = t("viewProcessed");
	const deleteEntry =
		onDeleteEntry ??
		((id: string) => {
			deleteTranscriptionHistoryEntry(id).catch(() => undefined);
		});
	const labels: MetaLabels = {
		duration: t("colDuration"),
		model: t("colModel"),
		processing: t("colProcessing"),
		speed: t("colSpeed"),
		sttModel: t("colSttModel"),
		time: t("colTime"),
		wpm: t("colWpm"),
		words: t("colWords"),
	};

	const rows = sorted.map((entry) => (
		<HistoryRow
			copyLabel={copyLabel}
			entry={entry}
			key={entry.id}
			labels={labels}
			onDeleteEntry={deleteEntry}
			outputDeviceId={outputDeviceId}
			showAudioStats={showAudioStats}
			viewFullLabel={viewFullLabel}
			viewOriginalLabel={viewOriginalLabel}
			viewProcessedLabel={viewProcessedLabel}
		/>
	));

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
				{rows}
			</div>
		);
	} else {
		body = (
			<VList
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
				{rows}
			</VList>
		);
	}

	return (
		<SurfaceProvider value={level}>
			<div
				className={cn(
					"overflow-hidden rounded-xl border border-border",
					surfaceBg(level),
				)}
			>
				{body}
			</div>
		</SurfaceProvider>
	);
}

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
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import {
	makerFromModelId,
	resolveProviderIcon,
} from "@/shared/lib/provider-icons";
import { Badge } from "@/shared/ui/badge";
import { ButtonGroup } from "@/shared/ui/button-group";
import {
	EntryCard,
	type EntryCardMetaPart,
	EntryCardShell,
} from "@/shared/ui/entry-card-list";
import {
	formatDuration,
	formatProcessingDuration,
	formatTokensPerSecond,
	formatWpm,
	wordsPerMinute,
} from "../lib/word-stats";
import { getEntryTranscriptDiff } from "../lib/transcript-diff-cache";
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
	const transcriptDiff = getEntryTranscriptDiff(entry);
	const hasOriginal = transcriptDiff !== null;
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
	const meta: EntryCardMetaPart[] = [
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
		const llmError = entry.llmError?.trim();
		// Title carries the full model id so truncation stays inspectable on hover.
		// When the cleanup fail-softed, keep the model visible but mark it as failed.
		meta.push({
			danger: Boolean(llmError),
			icon: CpuIcon,
			key: "model",
			logo: resolveProviderIcon(makerFromModelId(entry.llmModel)),
			title: llmError
				? `${entry.llmModel}\nPost-processing failed: ${llmError}`
				: entry.llmModel,
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
		<EntryCard footer={meta}>
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
		</EntryCard>
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
	// Most recent first; entries are stored chronologically by the main process.
	const sorted = [...entries].reverse();
	const copyLabel = t("copy");
	const viewFullLabel = t("viewFull");
	const viewOriginalLabel = t("viewOriginal");
	const viewProcessedLabel = t("viewProcessed");
	const deleteEntry =
		onDeleteEntry ??
		((id: string) => {
			fireAndForget(deleteTranscriptionHistoryEntry(id), "history.deleteEntry");
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

	const renderRow = (entry: TranscriptionHistoryEntry) => (
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
	);

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

	return <EntryCardShell>{body}</EntryCardShell>;
}

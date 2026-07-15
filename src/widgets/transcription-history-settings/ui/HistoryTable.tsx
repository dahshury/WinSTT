import { AiEditingIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { VList } from "virtua";
import { useSettingsStore } from "@/entities/setting";
import {
	deleteTranscriptionHistoryEntry,
	deleteTransformHistoryEntry,
	deleteTtsHistoryEntry,
} from "@/shared/api/ipc-client";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import { formatTime } from "@/shared/lib/format-time";
import { useSpeechActivityRef } from "@/shared/lib/use-speech-activity-ref";
import { ButtonGroup } from "@/shared/ui/button-group";
import { EntryCard, EntryCardShell } from "@/shared/ui/entry-card-list";
import { MediaSeekBar } from "@/shared/ui/media-seek-bar";
import { StaggerReveal } from "@/shared/ui/stagger-reveal";
import { Tooltip } from "@/shared/ui/tooltip";
import { getEntryTranscriptDiff } from "../lib/transcript-diff-cache";
import type {
	HistoryTableEntryKind,
	HistoryTableItem,
} from "../model/history-table-types";
import { useHistoryPlayback } from "../model/use-history-playback";
import {
	CopyButton,
	DeleteButton,
	PlayButton,
	SwapButton,
} from "./HistoryRowButtons";
import { buildHistoryRowMeta, type MetaLabels } from "./HistoryRowMeta";
import { RowTranscript } from "./RowTranscript";

export type {
	HistoryTableEntryKind,
	HistoryTableItem,
} from "../model/history-table-types";

interface HistoryTableProps {
	emptyLabel?: string;
	entries: HistoryTableItem[];
	highlights?: Map<string, Array<{ end: number; start: number }>> | undefined;
	onDeleteEntry?: (id: string, kind: HistoryTableEntryKind) => void;
	preserveOrder?: boolean;
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

function historyItemKey(item: HistoryTableItem): string {
	return `${item.kind}:${item.entry.id}`;
}

// Playback-speed steps for the seek-bar's cycle button (matches the common
// media-player pill: tap to advance 1× → 1.5× → 2× → back to 1×).
const PLAYBACK_RATES = [1, 1.5, 2];

function nextPlaybackRate(current: number): number {
	const index = PLAYBACK_RATES.indexOf(current);
	return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? 1;
}

function HistoryTimestamp({ timestamp }: { timestamp: number }) {
	const date = new Date(timestamp);
	return (
		<time
			className="flex w-7 flex-col items-center text-center text-[7px] text-foreground-muted leading-[9px] tabular-nums"
			dateTime={date.toISOString()}
		>
			<span className="whitespace-nowrap">
				{date.toLocaleTimeString(undefined, {
					hour: "numeric",
					minute: "2-digit",
				})}
			</span>
			<span className="whitespace-nowrap text-foreground-muted/75">
				{date.toLocaleDateString(undefined, {
					month: "short",
					day: "numeric",
				})}
			</span>
		</time>
	);
}

interface HistoryRowProps {
	copyLabel: string;
	item: HistoryTableItem;
}

interface HistoryRowFullProps extends HistoryRowProps {
	highlights?: Array<{ end: number; start: number }> | undefined;
	labels: MetaLabels;
	onDeleteEntry: (id: string, kind: HistoryTableEntryKind) => void;
	outputDeviceId: string;
	playbackSpeedLabel: string;
	viewFullLabel: string;
	viewOriginalLabel: string;
	viewProcessedLabel: string;
}

function HistoryRow({
	copyLabel,
	highlights,
	item,
	labels,
	onDeleteEntry,
	outputDeviceId,
	playbackSpeedLabel,
	viewFullLabel,
	viewOriginalLabel,
	viewProcessedLabel,
}: HistoryRowFullProps) {
	const { entry, kind, tts } = item;
	// Both audio-backed kinds play through the same machinery: STT rows play the
	// saved recording, TTS rows the saved synthesis. Rows whose file is gone
	// (legacy / retention / capture failure) keep an inert play button.
	const hasPlayableAudio =
		kind === "transcription"
			? Boolean(entry.audioFilePath)
			: kind === "tts" && Boolean(tts?.audioFilePath);
	const playback = useHistoryPlayback(
		entry.id,
		hasPlayableAudio,
		outputDeviceId,
		kind === "tts" ? "tts" : "stt",
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
	// The card's edge-rail accent and the footer's per-stage meta strip are built
	// off the entry's telemetry — extracted into `buildHistoryRowMeta` so this
	// component stays focused on playback state and layout.
	const { accent, meta } = buildHistoryRowMeta(item, labels);
	return (
		<EntryCard accent={accent} footer={meta} singleLine>
			<div className="flex items-start gap-3">
				{/* The leading slot is the transport control for BOTH audio kinds —
				    nothing ever replaces the play icon (kind reads through the card's
				    edge rail). Rows with no saved audio keep an inert, dimmed play
				    button whose tooltip says why. Transform rows have no audio ever,
				    so they keep their accent bubble. */}
				<div className="flex shrink-0 flex-col items-center gap-1">
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
					) : (
						<PlayButton
							loading={playback.loading}
							onToggle={handlePlaybackToggle}
							playing={playback.playing}
							unavailable={hasPlayableAudio ? undefined : labels.notRecorded}
						/>
					)}
					<HistoryTimestamp timestamp={entry.timestamp} />
				</div>
				<RowTranscript
					activeIndex={playback.activeIndex}
					diff={transcriptDiff}
					displayText={displayText}
					highlights={showOriginal ? undefined : highlights}
					playbackActive={playbackViewActive}
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
				{/* Row actions pin to the top-trailing corner. The kind tag and the
				    sensitive marker no longer live here — they moved to the footer meta
				    strip so this column stays as narrow as the button stack and the
				    transcript keeps its full width. */}
				<ButtonGroup
					aria-label={copyLabel}
					className="shrink-0 self-start"
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
					{/* Speed pill — cycles 1× → 1.5× → 2×. Fixed width so the label
					    change never shifts the bar; grayscale like the time labels. */}
					<button
						aria-label={playbackSpeedLabel}
						className="w-8 shrink-0 cursor-pointer rounded-sm px-1 py-0.5 text-center font-mono tabular-nums transition-colors hover:bg-foreground/10 hover:text-foreground"
						onClick={() => playback.setRate(nextPlaybackRate(playback.rate))}
						title={playbackSpeedLabel}
						type="button"
					>
						{playback.rate}×
					</button>
				</div>
			) : null}
		</EntryCard>
	);
}

export function HistoryTable({
	emptyLabel,
	entries,
	highlights,
	onDeleteEntry,
	preserveOrder = false,
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
	const playbackSpeedLabel = t("playbackSpeed");
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
		totalProcessing: t("durationTotalProcessing"),
		transform: t("transformTableTitle"),
		ttsModel: t("colTtsModel"),
		voice: t("colVoice"),
		wpm: t("colWpm"),
		words: t("colWords"),
	};

	const sorted = preserveOrder
		? entries
		: entries
				.map((item, index) => ({ index, item }))
				.sort(
					(a, b) =>
						b.item.entry.timestamp - a.item.entry.timestamp ||
						b.index - a.index,
				)
				.map(({ item }) => item);

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
					highlights={highlights?.get(key)}
					item={item}
					labels={labels}
					onDeleteEntry={deleteEntry}
					outputDeviceId={outputDeviceId}
					playbackSpeedLabel={playbackSpeedLabel}
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

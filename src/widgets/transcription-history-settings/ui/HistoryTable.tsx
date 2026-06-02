import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
	AiBrain02Icon,
	Clock01Icon,
	Copy01Icon,
	CopyCheckIcon,
	CpuIcon,
	DashboardSpeed02Icon,
	Delete02Icon,
	FlashIcon,
	HourglassIcon,
	PauseIcon,
	PlayIcon,
	StopWatchIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Fragment, type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { VList } from "virtua";
import { useSettingsStore } from "@/entities/setting";
import {
	alignTranscriptionHistoryAudio,
	clipboardWriteText,
	deleteTranscriptionHistoryEntry,
	loadTranscriptionHistoryAudio,
	type WordTiming,
} from "@/shared/api/ipc-client";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import { makerFromModelId, resolveProviderIcon } from "@/shared/lib/provider-icons";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { ButtonGroup } from "@/shared/ui/button-group";
import { Spinner } from "@/shared/ui/spinner";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	formatDuration,
	formatProcessingDuration,
	formatTokensPerSecond,
	formatWpm,
	wordsPerMinute,
} from "../lib/word-stats";
import type { TranscriptionHistoryEntry } from "../model/history-store";

interface HistoryTableProps {
	entries: TranscriptionHistoryEntry[];
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

function copyEntryText(text: string): void {
	// The Web Clipboard API works directly from the renderer (localhost is a
	// secure context) and bypasses the encrypted IPC round-trip whose errors
	// `invokeSecureOrDefault` would swallow. Fall back to IPC if it's missing
	// or refuses (e.g. no user gesture, focus lost).
	const webClipboard = globalThis.navigator?.clipboard;
	if (webClipboard?.writeText) {
		webClipboard.writeText(text).catch(() => {
			clipboardWriteText(text).catch(() => undefined);
		});
		return;
	}
	clipboardWriteText(text).catch(() => undefined);
}

/**
 * Switch the underlying audio sink for an HTMLAudioElement. `setSinkId` is
 * gated on a "speaker-selection" permission that Electron grants by default
 * for the file-loaded renderer, but the call still fails on devices that
 * don't exist or aren't reachable — swallow that case (the play silently
 * falls back to the system default rather than throwing inside the JSX).
 */
async function routeAudioToSink(el: HTMLAudioElement, deviceId: string): Promise<void> {
	if (!deviceId) {
		return;
	}
	const setSinkId = (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
		.setSinkId;
	if (!setSinkId) {
		return;
	}
	try {
		await setSinkId.call(el, deviceId);
	} catch {
		// device unavailable — system default takes over
	}
}

interface PlaybackState {
	activeIndex: number;
	loading: boolean;
	playing: boolean;
	toggle: () => void;
	words: WordTiming[] | null;
}

/**
 * Binary-search the last word whose start time has been reached, so silences
 * and gaps keep the prior word lit. Returns -1 before the first word.
 */
function findActiveWordIndex(words: WordTiming[], t: number): number {
	let lo = 0;
	let hi = words.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		const word = words[mid];
		if (word && word.start <= t) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans;
}

/**
 * Owns a row's `<audio>` element. On first play it lazily fetches both the WAV
 * and the per-word timestamps, then tracks playback position with a rAF loop —
 * the word-highlight sweep doubles as the progress indicator. No-ops when the
 * entry has no recording; called unconditionally per row (Rules of Hooks).
 */
function useHistoryPlayback(
	entryId: string,
	hasAudio: boolean,
	outputDeviceId: string
): PlaybackState {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const rafRef = useRef<number | null>(null);
	const [playing, setPlaying] = useState(false);
	const [loading, setLoading] = useState(false);
	const [words, setWords] = useState<WordTiming[] | null>(null);
	const [currentTime, setCurrentTime] = useState(0);

	useEffect(
		() => () => {
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
			}
			audioRef.current?.pause();
			audioRef.current = null;
		},
		[]
	);

	const stopTicking = () => {
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
	};

	const tick = () => {
		if (audioRef.current) {
			setCurrentTime(audioRef.current.currentTime);
		}
		rafRef.current = requestAnimationFrame(tick);
	};

	const beginPlayback = async () => {
		if (!audioRef.current) {
			setLoading(true);
			// Fetch WAV bytes + word timings together on first play.
			const [dataUri, timings] = await Promise.all([
				loadTranscriptionHistoryAudio(entryId),
				alignTranscriptionHistoryAudio(entryId),
			]);
			setLoading(false);
			if (!dataUri) {
				return;
			}
			if (timings.length > 0) {
				setWords(timings);
			}
			const el = new Audio(dataUri);
			el.onended = () => {
				setPlaying(false);
				setCurrentTime(0);
				stopTicking();
			};
			audioRef.current = el;
		}
		await routeAudioToSink(audioRef.current, outputDeviceId);
		try {
			await audioRef.current.play();
		} catch (err) {
			// Don't leave the button stuck in a fake "playing" state if the
			// element can't start (decode/CSP/device) — surface it and bail.
			console.error("[history] playback failed", err);
			setPlaying(false);
			return;
		}
		setPlaying(true);
		stopTicking();
		rafRef.current = requestAnimationFrame(tick);
	};

	const toggle = () => {
		if (!hasAudio) {
			return;
		}
		if (playing && audioRef.current) {
			audioRef.current.pause();
			setPlaying(false);
			stopTicking();
			return;
		}
		beginPlayback().catch(() => undefined);
	};

	const activeIndex = playing && words ? findActiveWordIndex(words, currentTime) : -1;
	return { activeIndex, loading, playing, toggle, words };
}

function PlayButton({
	loading,
	onToggle,
	playing,
}: {
	loading: boolean;
	onToggle: () => void;
	playing: boolean;
}) {
	let label = "Play recording";
	if (loading) {
		label = "Loading recording";
	} else if (playing) {
		label = "Pause recording";
	}
	return (
		<button
			aria-label={label}
			className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-accent transition-[color,background-color,transform] hover:bg-accent/15 active:scale-95"
			disabled={loading}
			onClick={onToggle}
			type="button"
		>
			{loading ? (
				<Spinner className="size-3.5" />
			) : (
				<HugeiconsIcon className="size-4" icon={playing ? PauseIcon : PlayIcon} />
			)}
		</button>
	);
}

function CopyButton({ label, text }: { label: string; text: string }) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
		},
		[]
	);

	const handleCopy = () => {
		copyEntryText(text);
		setCopied(true);
		if (timerRef.current) {
			clearTimeout(timerRef.current);
		}
		// Hold the check just long enough to read as confirmation, then revert.
		timerRef.current = setTimeout(() => setCopied(false), 1600);
	};

	// Both glyphs are stacked and cross-faded (scale + opacity) so the copy →
	// check swap animates, matching fluidfunctionalism's input-copy "icon"
	// variant. The Base UI Tooltip supplies the accessible label on hover.
	return (
		<Tooltip content={label}>
			<button
				aria-label={label}
				className="relative inline-flex size-7 items-center justify-center text-foreground-muted transition-[color,background-color,transform] hover:bg-surface-hover hover:text-foreground active:scale-95"
				onClick={handleCopy}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"absolute size-3.5 transition-[opacity,transform] duration-200 ease-out",
						copied ? "scale-50 opacity-0" : "scale-100 opacity-100"
					)}
					icon={Copy01Icon}
				/>
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"absolute size-3.5 text-success transition-[opacity,transform] duration-200 ease-out",
						copied ? "scale-100 opacity-100" : "scale-50 opacity-0"
					)}
					icon={CopyCheckIcon}
				/>
			</button>
		</Tooltip>
	);
}

function DeleteButton({ entryId }: { entryId: string }) {
	return (
		<button
			aria-label="Delete entry"
			className="inline-flex size-7 items-center justify-center text-foreground-muted transition-[color,background-color,transform] hover:bg-error/15 hover:text-error active:scale-95"
			onClick={() => {
				deleteTranscriptionHistoryEntry(entryId).catch(() => undefined);
			}}
			type="button"
		>
			<HugeiconsIcon className="size-3.5" icon={Delete02Icon} />
		</button>
	);
}

/**
 * Toggles a row's transcript between the AI-edited final text and the raw
 * pre-LLM original. Only mounted for entries that actually carried an LLM
 * post-process step (``originalText`` present). The glyph doubles as a state
 * indicator: the brain (accent) when the AI version is showing, the text glyph
 * when the original is showing — so the row reads as AI-touched at a glance.
 * The label describes the action the click performs, matching the copy
 * button's icon-swap convention above.
 */
function SwapButton({
	onToggle,
	showOriginal,
	showOriginalLabel,
	showProcessedLabel,
}: {
	onToggle: () => void;
	showOriginal: boolean;
	showOriginalLabel: string;
	showProcessedLabel: string;
}) {
	const label = showOriginal ? showProcessedLabel : showOriginalLabel;
	return (
		<Tooltip content={label}>
			<button
				aria-label={label}
				aria-pressed={showOriginal}
				className="relative inline-flex size-7 items-center justify-center text-foreground-muted transition-[color,background-color,transform] hover:bg-surface-hover hover:text-foreground active:scale-95"
				onClick={onToggle}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"absolute size-3.5 text-accent transition-[opacity,transform] duration-200 ease-out",
						showOriginal ? "scale-50 opacity-0" : "scale-100 opacity-100"
					)}
					icon={AiBrain02Icon}
				/>
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"absolute size-3.5 transition-[opacity,transform] duration-200 ease-out",
						showOriginal ? "scale-100 opacity-100" : "scale-50 opacity-0"
					)}
					icon={TextFontIcon}
				/>
			</button>
		</Tooltip>
	);
}

/**
 * Reveals a row's complete transcript in a hover/focus popup — the same Base UI
 * Tooltip surface the feature demos use — for transcripts the row clamps to four
 * lines. Read-only on purpose: the copy button already copies the full text, so
 * this popup just lifts the truncation cap for reading. Wraps the clamped
 * paragraph as its own trigger (no separate affordance), so hovering the "…"
 * text itself opens it.
 */
function FullTranscriptHover({
	children,
	label,
	text,
}: {
	children: ReactElement;
	label: string;
	text: string;
}) {
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	return (
		<TooltipPrimitive.Root>
			<TooltipPrimitive.Trigger render={children} />
			<TooltipPrimitive.Portal>
				<SurfaceProvider value={popupLevel}>
					<TooltipPrimitive.Positioner
						side="top"
						sideOffset={8}
						style={{ zIndex: Z_INDEX.tooltip }}
					>
						<TooltipPrimitive.Popup
							aria-label={label}
							className={cn(
								"max-w-[min(28rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-lg p-3 transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
								surfaceClasses(popupLevel, popupShadow)
							)}
						>
							<div className="max-h-[40vh] select-text overflow-y-auto whitespace-pre-wrap break-words text-body text-foreground leading-relaxed">
								{text}
							</div>
						</TooltipPrimitive.Popup>
					</TooltipPrimitive.Positioner>
				</SurfaceProvider>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}

interface RowTranscriptProps {
	activeIndex: number;
	displayText: string;
	viewFullLabel: string;
	words: WordTiming[] | null;
}

/**
 * Renders a row's transcript body. At rest the text is clamped to four lines
 * (CSS `-webkit-line-clamp`, which appends the trailing "…"); when it actually
 * overflows that cap we attach a hover popup with the full text. During
 * playback the word-timed spans render UNclamped instead, so the highlight
 * sweep never scrolls out of view — playback is transient and reads top-down.
 */
function RowTranscript({ activeIndex, displayText, viewFullLabel, words }: RowTranscriptProps) {
	const [clamped, setClamped] = useState(false);
	const showWords = words !== null && words.length > 0;

	// Toggling `clamped` swaps the returned root element (plain <p> ↔ tooltip
	// wrapper), which REMOUNTS the paragraph. A callback ref re-attaches the
	// ResizeObserver to whichever <p> is currently live — a useEffect+useRef
	// would leave the observer bound to the detached node and flip-flop. Each
	// transition measures the actually-attached node, so it converges.
	const observerRef = useRef<ResizeObserver | null>(null);
	const measureRef = useCallback(
		(node: HTMLParagraphElement | null) => {
			observerRef.current?.disconnect();
			observerRef.current = null;
			if (!node || showWords) {
				setClamped(false);
				return;
			}
			// line-clamp keeps clientHeight at the 4-line cap while scrollHeight
			// grows with the full content — the gap is the truncation signal.
			const measure = () => setClamped(node.scrollHeight - node.clientHeight > 1);
			measure();
			if (typeof ResizeObserver !== "undefined") {
				const observer = new ResizeObserver(measure);
				observer.observe(node);
				observerRef.current = observer;
			}
		},
		// `displayText` is a dep so swapping original↔AI re-measures: the ref
		// identity changes, React re-runs it on the same node, and the new text's
		// overflow is re-evaluated (a short AI text may not clamp while its longer
		// original does, or vice versa).
		[displayText, showWords]
	);

	const paragraph = (
		<p
			className={cn(
				"mt-0.5 min-w-0 flex-1 select-text whitespace-pre-wrap break-words text-body text-foreground leading-relaxed",
				!showWords && "line-clamp-4"
			)}
			ref={measureRef}
		>
			{showWords && words
				? words.map((word, index) => (
						<Fragment key={`${word.start}-${index}`}>
							{index > 0 ? " " : null}
							<span
								className={
									index === activeIndex ? "rounded-[3px] bg-accent/25 text-foreground" : undefined
								}
							>
								{word.text}
							</span>
						</Fragment>
					))
				: displayText}
		</p>
	);

	if (showWords || !clamped) {
		return paragraph;
	}
	return (
		<FullTranscriptHover label={viewFullLabel} text={displayText}>
			{paragraph}
		</FullTranscriptHover>
	);
}

interface MetaLabels {
	duration: string;
	model: string;
	processing: string;
	speed: string;
	time: string;
	words: string;
	wpm: string;
}

interface HistoryRowFullProps extends HistoryRowProps {
	labels: MetaLabels;
	outputDeviceId: string;
	viewFullLabel: string;
	viewOriginalLabel: string;
	viewProcessedLabel: string;
}

function HistoryRow({
	entry,
	copyLabel,
	labels,
	outputDeviceId,
	viewFullLabel,
	viewOriginalLabel,
	viewProcessedLabel,
}: HistoryRowFullProps) {
	const playback = useHistoryPlayback(entry.id, Boolean(entry.audioFilePath), outputDeviceId);
	const hasOriginal = entry.originalText !== undefined && entry.originalText.length > 0;
	// Each entry is its own elevated card, one surface step above the list it sits
	// in (FF surfaces: substrate flows through context, lift +1). The meta footer
	// then recesses BACK to the list surface (`cardLevel - 1`) so it reads as a
	// distinct ledge under the card body — the STT model card's recessed-shelf idea.
	const cardLevel = Math.min(useSurface() + 1, 8);
	// Per-row view toggle for LLM-processed entries; resets implicitly because
	// each row is keyed by entry.id. Defaults to the AI-edited final text.
	const [showOriginal, setShowOriginal] = useState(false);
	const displayText = showOriginal && entry.originalText ? entry.originalText : entry.text;
	const wpm = wordsPerMinute(entry.wordCount, entry.durationMs);
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
		{ icon: Clock01Icon, key: "time", title: labels.time, value: formatTimestamp(entry.timestamp) },
		{ icon: TextFontIcon, key: "words", title: labels.words, value: String(entry.wordCount) },
		{
			icon: StopWatchIcon,
			key: "duration",
			title: labels.duration,
			value: formatDuration(entry.durationMs),
		},
	];
	if (wpm > 0) {
		meta.push({ icon: DashboardSpeed02Icon, key: "wpm", title: labels.wpm, value: formatWpm(wpm) });
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
		entry.llmProcessingMs !== undefined ? formatProcessingDuration(entry.llmProcessingMs) : null;
	if (processing) {
		meta.push({
			icon: HourglassIcon,
			key: "processing",
			title: labels.processing,
			value: processing,
		});
	}
	const speed =
		entry.llmTokensPerSecond !== undefined ? formatTokensPerSecond(entry.llmTokensPerSecond) : null;
	if (speed) {
		meta.push({ icon: FlashIcon, key: "speed", title: labels.speed, value: speed });
	}
	return (
		// Per-card padding wrapper: virtua measures the border-box (margins are
		// NOT counted), so the inter-card gap lives here as padding, never as a
		// margin on the card itself.
		<div className="px-2 py-1">
			<SurfaceProvider value={cardLevel}>
				<div
					className={cn(
						"flex flex-col gap-2.5 overflow-hidden rounded-xl border border-border px-3.5 py-3",
						surfaceClasses(cardLevel, Math.max(cardLevel - 1, 1)),
						"transition-colors duration-150",
						surfaceHoverBg(Math.min(cardLevel + 1, 8)),
						"hover:border-border-hover"
					)}
				>
					<div className="flex items-start gap-3">
						{entry.audioFilePath ? (
							<PlayButton
								loading={playback.loading}
								onToggle={playback.toggle}
								playing={playback.playing}
							/>
						) : null}
						<RowTranscript
							activeIndex={playback.activeIndex}
							displayText={displayText}
							viewFullLabel={viewFullLabel}
							words={playback.words}
						/>
						<ButtonGroup
							aria-label={copyLabel}
							className="shrink-0 self-start"
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
							<DeleteButton entryId={entry.id} />
						</ButtonGroup>
					</div>
					{/* Recessed meta shelf: full-bleed to the card's bottom + side edges
					    (negative margins MUST match the card's px-3.5/py-3), split off by a
					    hairline, and stepped DOWN one surface so it reads as a ledge. */}
					<div
						className={cn(
							"-mx-3.5 -mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-divider border-t px-3.5 pt-2.5 pb-3 text-foreground-secondary text-xs-tight",
							surfaceBg(Math.max(cardLevel - 1, 1))
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
								<span className={part.truncate ? "max-w-[10rem] truncate" : "whitespace-nowrap"}>
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

export function HistoryTable({ entries }: HistoryTableProps) {
	const t = useTranslations("history");
	const outputDeviceId = useSettingsStore((s) => s.settings.general.outputDeviceId);
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
	const labels: MetaLabels = {
		duration: t("colDuration"),
		model: t("colModel"),
		processing: t("colProcessing"),
		speed: t("colSpeed"),
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
			outputDeviceId={outputDeviceId}
			viewFullLabel={viewFullLabel}
			viewOriginalLabel={viewOriginalLabel}
			viewProcessedLabel={viewProcessedLabel}
		/>
	));

	let body: React.ReactNode;
	if (sorted.length === 0) {
		body = (
			<div className="px-3 py-6 text-center text-body-sm text-foreground-muted">
				{t("tableEmpty")}
			</div>
		);
	} else if (sorted.length < VIRTUALIZE_THRESHOLD) {
		body = (
			<div className="overflow-y-auto" style={{ maxHeight: MAX_BODY_HEIGHT_PX }}>
				{rows}
			</div>
		);
	} else {
		body = (
			<VList
				itemSize={ROW_HEIGHT_HINT_PX}
				style={{
					height: Math.min(sorted.length * ROW_HEIGHT_HINT_PX, MAX_BODY_HEIGHT_PX),
				}}
			>
				{rows}
			</VList>
		);
	}

	return (
		<SurfaceProvider value={level}>
			<div className={cn("overflow-hidden rounded-xl border border-border", surfaceBg(level))}>
				{body}
			</div>
		</SurfaceProvider>
	);
}

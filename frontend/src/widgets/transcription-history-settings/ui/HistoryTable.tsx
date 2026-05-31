import { ContextMenu } from "@base-ui/react/context-menu";
import {
	Clock01Icon,
	Copy01Icon,
	CopyCheckIcon,
	CpuIcon,
	DashboardSpeed02Icon,
	Delete02Icon,
	PauseIcon,
	PlayIcon,
	StopWatchIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Fragment, useEffect, useRef, useState } from "react";
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
import {
	SurfaceProvider,
	surfaceBg,
	surfaceClasses,
	surfaceHighlightedBg,
	useSurface,
} from "@/shared/lib/surface";
import { ButtonGroup } from "@/shared/ui/button-group";
import { Spinner } from "@/shared/ui/spinner";
import { Tooltip } from "@/shared/ui/tooltip";
import { formatDuration, formatWpm, wordsPerMinute } from "../lib/word-stats";
import type { TranscriptionHistoryEntry } from "../model/history-store";

interface HistoryTableProps {
	entries: TranscriptionHistoryEntry[];
}

// Initial size estimate only — virtua re-measures every mounted row, so rows
// whose transcripts wrap to several lines self-correct. A short transcript +
// divider + meta strip lands around this height.
const ROW_HEIGHT_HINT_PX = 104;
// Cap the visible body so the table doesn't crowd out the rest of the panel;
// anything beyond this scrolls. Generous so the transcription list reads as a
// roomy, dedicated scroll region rather than a cramped box; the body
// deliberately omits `overscroll-contain` so reaching either end chains the
// wheel to the page's ScrollArea instead of trapping the scroll.
const MAX_BODY_HEIGHT_PX = 560;
// Below this row count, render directly (cheaper than VList's bookkeeping);
// at/above it, virtualize so the ContextMenu.Root count stays bounded.
const VIRTUALIZE_THRESHOLD = 50;
const MENU_SURFACE_LEVEL = 6;
const MENU_SHADOW_LEVEL = 7;

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
	copyOriginalLabel: string;
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

interface MetaLabels {
	duration: string;
	model: string;
	time: string;
	words: string;
	wpm: string;
}

interface HistoryRowFullProps extends HistoryRowProps {
	labels: MetaLabels;
	outputDeviceId: string;
}

function HistoryRow({
	entry,
	copyLabel,
	copyOriginalLabel,
	labels,
	outputDeviceId,
}: HistoryRowFullProps) {
	const playback = useHistoryPlayback(entry.id, Boolean(entry.audioFilePath), outputDeviceId);
	const hasOriginal = entry.originalText !== undefined && entry.originalText.length > 0;
	const wpm = wordsPerMinute(entry.wordCount, entry.durationMs);
	// Icon + bare value, reusing the summary tiles' stat icons (words / duration
	// / wpm) so a row reads as part of the same family. Dropping the inline text
	// labels keeps the strip on ONE line; the icon + hover title carry meaning.
	// Optional parts (wpm, model) drop out cleanly when absent.
	const meta: {
		icon: IconSvgElement;
		key: string;
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
	if (entry.llmModel) {
		// Title carries the full model id so truncation stays inspectable on hover.
		meta.push({
			icon: CpuIcon,
			key: "model",
			title: entry.llmModel,
			truncate: true,
			value: entry.llmModel,
		});
	}
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger
				render={
					<div className="border-border border-b px-3.5 py-3 transition-colors duration-100 hover:bg-surface-hover" />
				}
			>
				<div className="flex items-start gap-3">
					{entry.audioFilePath ? (
						<PlayButton
							loading={playback.loading}
							onToggle={playback.toggle}
							playing={playback.playing}
						/>
					) : null}
					<p className="mt-0.5 min-w-0 flex-1 select-text whitespace-pre-wrap break-words text-body text-foreground leading-relaxed">
						{playback.words
							? playback.words.map((word, index) => (
									<Fragment key={`${word.start}-${index}`}>
										{index > 0 ? " " : null}
										<span
											className={
												index === playback.activeIndex
													? "rounded-[3px] bg-accent/25 text-foreground"
													: undefined
											}
										>
											{word.text}
										</span>
									</Fragment>
								))
							: entry.text}
					</p>
					<ButtonGroup
						aria-label={copyLabel}
						className="shrink-0 self-start"
						connected
						orientation="vertical"
					>
						<CopyButton label={copyLabel} text={entry.text} />
						<DeleteButton entryId={entry.id} />
					</ButtonGroup>
				</div>
				<div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-border/60 border-t pt-2 text-foreground-secondary text-xs-tight">
					{meta.map((part) => (
						<span
							className="inline-flex min-w-0 items-center gap-1 tabular-nums"
							key={part.key}
							title={part.title}
						>
							<HugeiconsIcon
								aria-hidden="true"
								className="size-3.5 shrink-0 text-foreground-muted"
								icon={part.icon}
								strokeWidth={1.75}
							/>
							<span className={part.truncate ? "max-w-[10rem] truncate" : "whitespace-nowrap"}>
								{part.value}
							</span>
						</span>
					))}
				</div>
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<SurfaceProvider value={MENU_SURFACE_LEVEL}>
					<ContextMenu.Positioner style={{ zIndex: Z_INDEX.popover }}>
						<ContextMenu.Popup
							className={cn(
								"min-w-[12rem] overflow-hidden rounded-md p-1 font-sans text-body text-foreground transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
								surfaceClasses(MENU_SURFACE_LEVEL, MENU_SHADOW_LEVEL)
							)}
						>
							<ContextMenu.Item
								className={cn(
									"flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-body outline-none data-[disabled]:pointer-events-none data-[highlighted]:text-foreground data-[disabled]:opacity-50",
									surfaceHighlightedBg(MENU_SURFACE_LEVEL + 1)
								)}
								onClick={() => copyEntryText(entry.text)}
							>
								{copyLabel}
							</ContextMenu.Item>
							<ContextMenu.Item
								className={cn(
									"flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-body outline-none data-[disabled]:pointer-events-none data-[highlighted]:text-foreground data-[disabled]:opacity-50",
									surfaceHighlightedBg(MENU_SURFACE_LEVEL + 1)
								)}
								disabled={!hasOriginal}
								onClick={() => {
									if (entry.originalText) {
										copyEntryText(entry.originalText);
									}
								}}
							>
								{copyOriginalLabel}
							</ContextMenu.Item>
						</ContextMenu.Popup>
					</ContextMenu.Positioner>
				</SurfaceProvider>
			</ContextMenu.Portal>
		</ContextMenu.Root>
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
	const copyOriginalLabel = t("copyOriginal");
	const labels: MetaLabels = {
		duration: t("colDuration"),
		model: t("colModel"),
		time: t("colTime"),
		wpm: t("colWpm"),
		words: t("colWords"),
	};

	const rows = sorted.map((entry) => (
		<HistoryRow
			copyLabel={copyLabel}
			copyOriginalLabel={copyOriginalLabel}
			entry={entry}
			key={entry.id}
			labels={labels}
			outputDeviceId={outputDeviceId}
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
			<div className={cn("overflow-hidden rounded-md border border-border", surfaceBg(level))}>
				{body}
			</div>
		</SurfaceProvider>
	);
}

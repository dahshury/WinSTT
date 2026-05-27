import { ContextMenu } from "@base-ui/react/context-menu";
import { Delete02Icon, PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { VList } from "virtua";
import { useSettingsStore } from "@/entities/setting";
import {
	clipboardWriteText,
	deleteTranscriptionHistoryEntry,
	loadTranscriptionHistoryAudio,
} from "@/shared/api/ipc-client";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceClasses, surfaceHighlightedBg } from "@/shared/lib/surface";
import { formatDuration, formatWpm, wordsPerMinute } from "../lib/word-stats";
import type { TranscriptionHistoryEntry } from "../model/history-store";

interface HistoryTableProps {
	entries: TranscriptionHistoryEntry[];
}

// Hint only — virtua re-measures every mounted row.
const ROW_HEIGHT_HINT_PX = 36;
// Cap the visible body at ~10 rows; anything beyond scrolls.
const VISIBLE_ROW_COUNT = 10;
const MAX_BODY_HEIGHT_PX = VISIBLE_ROW_COUNT * ROW_HEIGHT_HINT_PX;
// Below this row count, render directly (cheaper than VList's bookkeeping);
// at/above it, virtualize so the ContextMenu.Root count stays bounded.
const VIRTUALIZE_THRESHOLD = 50;
// Each track is `minmax(min, max)` so columns shrink gracefully when the
// settings sidebar expands. Without this, fixed widths summed to 534px and
// squeezed the text column to ~0 inside the 700px settings window.
const COLUMN_TEMPLATE =
	"minmax(100px, 150px) minmax(40px, 56px) minmax(48px, 64px) minmax(40px, 56px) minmax(60px, 110px) minmax(100px, 1fr) 64px";
const MENU_SURFACE_LEVEL = 6;
const MENU_SHADOW_LEVEL = 7;

function formatTimestamp(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
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

interface PlayButtonProps {
	entryId: string;
	outputDeviceId: string;
}

function PlayButton({ entryId, outputDeviceId }: PlayButtonProps) {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [playing, setPlaying] = useState(false);
	const [loading, setLoading] = useState(false);

	useEffect(
		() => () => {
			audioRef.current?.pause();
			audioRef.current = null;
		},
		[]
	);

	const togglePlay = async () => {
		if (playing && audioRef.current) {
			audioRef.current.pause();
			setPlaying(false);
			return;
		}
		// Lazy-load on first click — avoids fetching every WAV up front.
		if (!audioRef.current) {
			setLoading(true);
			const dataUri = await loadTranscriptionHistoryAudio(entryId);
			setLoading(false);
			if (!dataUri) {
				return;
			}
			const el = new Audio(dataUri);
			el.onended = () => setPlaying(false);
			audioRef.current = el;
		}
		await routeAudioToSink(audioRef.current, outputDeviceId);
		await audioRef.current.play().catch(() => undefined);
		setPlaying(true);
	};

	return (
		<button
			aria-label={playing ? "Pause recording" : "Play recording"}
			className="inline-flex size-6 items-center justify-center rounded-sm text-foreground-muted hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
			disabled={loading}
			onClick={togglePlay}
			type="button"
		>
			<HugeiconsIcon className="size-3.5" icon={playing ? PauseIcon : PlayIcon} />
		</button>
	);
}

function DeleteButton({ entryId }: { entryId: string }) {
	return (
		<button
			aria-label="Delete entry"
			className="inline-flex size-6 items-center justify-center rounded-sm text-foreground-muted hover:bg-error/15 hover:text-error"
			onClick={() => {
				deleteTranscriptionHistoryEntry(entryId).catch(() => undefined);
			}}
			type="button"
		>
			<HugeiconsIcon className="size-3.5" icon={Delete02Icon} />
		</button>
	);
}

interface ActionsCellProps {
	entry: TranscriptionHistoryEntry;
	outputDeviceId: string;
}

function ActionsCell({ entry, outputDeviceId }: ActionsCellProps) {
	return (
		<span className="flex items-center justify-end gap-0.5 px-2">
			{entry.audioFilePath ? (
				<PlayButton entryId={entry.id} outputDeviceId={outputDeviceId} />
			) : null}
			<DeleteButton entryId={entry.id} />
		</span>
	);
}

interface HistoryRowFullProps extends HistoryRowProps {
	outputDeviceId: string;
}

function HistoryRow({ entry, copyLabel, copyOriginalLabel, outputDeviceId }: HistoryRowFullProps) {
	const hasOriginal = entry.originalText !== undefined && entry.originalText.length > 0;
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger
				render={
					<div
						className="grid items-center border-border border-b text-body text-foreground-muted transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
						style={{ gridTemplateColumns: COLUMN_TEMPLATE }}
					/>
				}
			>
				<span className="whitespace-nowrap px-3 py-2 font-mono text-foreground-secondary text-xs-tight tabular-nums">
					{formatTimestamp(entry.timestamp)}
				</span>
				<span className="px-3 py-2 text-right tabular-nums">{entry.wordCount}</span>
				<span className="px-3 py-2 text-right tabular-nums">
					{formatDuration(entry.durationMs)}
				</span>
				<span className="px-3 py-2 text-right tabular-nums">
					{formatWpm(wordsPerMinute(entry.wordCount, entry.durationMs))}
				</span>
				<span
					className="truncate px-3 py-2 font-mono text-foreground-secondary text-xs-tight"
					title={entry.llmModel ?? ""}
				>
					{entry.llmModel ?? "—"}
				</span>
				<span className="truncate px-3 py-2 text-foreground" title={entry.text}>
					{entry.text}
				</span>
				<ActionsCell entry={entry} outputDeviceId={outputDeviceId} />
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
	// Most recent first; entries are stored chronologically by the main process.
	const sorted = [...entries].reverse();
	const copyLabel = t("copy");
	const copyOriginalLabel = t("copyOriginal");

	const rows = sorted.map((entry) => (
		<HistoryRow
			copyLabel={copyLabel}
			copyOriginalLabel={copyOriginalLabel}
			entry={entry}
			key={entry.id}
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
			<div className="overflow-y-auto overscroll-contain" style={{ maxHeight: MAX_BODY_HEIGHT_PX }}>
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
		<div className="overflow-hidden rounded border border-border bg-surface-tertiary">
			<div
				className="grid border-border border-b font-medium text-body text-foreground"
				style={{ gridTemplateColumns: COLUMN_TEMPLATE }}
			>
				<span className="whitespace-nowrap px-3 py-2 text-left">{t("colTime")}</span>
				<span className="px-3 py-2 text-right">{t("colWords")}</span>
				<span className="px-3 py-2 text-right">{t("colDuration")}</span>
				<span className="px-3 py-2 text-right">{t("colWpm")}</span>
				<span className="px-3 py-2 text-left">{t("colModel")}</span>
				<span className="px-3 py-2 text-left">{t("colText")}</span>
				<span className="px-3 py-2 text-right">{""}</span>
			</div>
			{body}
		</div>
	);
}

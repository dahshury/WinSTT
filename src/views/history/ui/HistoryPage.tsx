import {
	CopyCheckIcon,
	Delete02Icon,
	FavouriteIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
	deleteHistoryRow,
	effectiveText,
	formatEntryTimestamp,
	hasPrivacyMarkers,
	historyTagLabel,
	SENSITIVE_HISTORY_LABEL,
	type HistoryEntry,
	listHistoryPage,
	loadHistoryAudio,
	toggleHistoryRow,
	useHistoryViewStore,
} from "@/entities/transcription-history";
import {
	clipboardWriteText,
	onHistoryRowAdded,
	onHistoryRowDeleted,
	onHistoryRowToggled,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { useLongPress } from "@/shared/lib/use-long-press";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

function subscribeBroadcasts(callbacks: {
	onAdded: (entry: HistoryEntry) => void;
	onDeleted: (id: number) => void;
	onToggled: (id: number, saved: boolean) => void;
}): () => void {
	const offAdded = onHistoryRowAdded<HistoryEntry>((entry) => {
		callbacks.onAdded(entry);
	});
	const offDeleted = onHistoryRowDeleted((p) => {
		if (typeof p?.id === "number") {
			callbacks.onDeleted(p.id);
		}
	});
	const offToggled = onHistoryRowToggled((p) => {
		if (typeof p?.id === "number" && typeof p?.saved === "boolean") {
			callbacks.onToggled(p.id, p.saved);
		}
	});
	return () => {
		offAdded();
		offDeleted();
		offToggled();
	};
}

const PAGE_SIZE = 25;
const TOUCH_COPY_FEEDBACK_MS = 1600;

function copyHistoryText(text: string): void {
	const webClipboard = globalThis.navigator?.clipboard;
	if (webClipboard?.writeText) {
		webClipboard.writeText(text).catch(() => {
			clipboardWriteText(text).catch(() => undefined);
		});
		return;
	}
	clipboardWriteText(text).catch(() => undefined);
}

function LongPressTranscript({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	useEffect(
		() => () => {
			if (copyFeedbackTimerRef.current) {
				clearTimeout(copyFeedbackTimerRef.current);
			}
		},
		[],
	);

	const handleLongPressCopy = () => {
		if (!text) {
			return;
		}
		copyHistoryText(text);
		globalThis.navigator?.vibrate?.(10);
		setCopied(true);
		if (copyFeedbackTimerRef.current) {
			clearTimeout(copyFeedbackTimerRef.current);
		}
		copyFeedbackTimerRef.current = setTimeout(
			() => setCopied(false),
			TOUCH_COPY_FEEDBACK_MS,
		);
	};

	const longPress = useLongPress(handleLongPressCopy, {
		disabled: text.length === 0,
	});
	const touchCopyState = copied
		? "copied"
		: longPress.pressing
			? "pressing"
			: undefined;

	return (
		<div className="relative min-w-0">
			<p
				className={cn(
					"touch-copy-transcript min-w-0 whitespace-pre-wrap break-words rounded-sm text-sm transition-[background-color,box-shadow,transform] duration-150 [touch-action:pan-y]",
					longPress.pressing &&
						"scale-[0.998] bg-accent/10 shadow-[inset_0_0_0_1px_var(--color-border-accent)]",
					copied &&
						"scale-100 bg-success/10 shadow-[inset_0_0_0_1px_var(--color-success)]",
				)}
				data-long-press-copy="transcript"
				data-touch-copy-state={touchCopyState}
				dir="auto"
				{...longPress.handlers}
			>
				{text}
			</p>
			<span
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute -top-1 end-0 inline-flex size-5 items-center justify-center rounded-full bg-success-dim text-success shadow-sm transition-[opacity,transform] duration-150",
					copied ? "scale-100 opacity-100" : "scale-75 opacity-0",
				)}
			>
				<HugeiconsIcon icon={CopyCheckIcon} size={13} />
			</span>
		</div>
	);
}

export function HistoryPage() {
	const t = useTranslations("history");
	const entries = useHistoryViewStore((s) => s.entries);
	const hasMore = useHistoryViewStore((s) => s.hasMore);
	const loading = useHistoryViewStore((s) => s.loading);
	const replaceFirstPage = useHistoryViewStore((s) => s.replaceFirstPage);
	const appendPage = useHistoryViewStore((s) => s.appendPage);
	const insertRow = useHistoryViewStore((s) => s.insertRow);
	const removeRow = useHistoryViewStore((s) => s.removeRow);
	const toggleRowInStore = useHistoryViewStore((s) => s.toggleRow);
	const setLoading = useHistoryViewStore((s) => s.setLoading);

	const [playingId, setPlayingId] = useState<number | null>(null);
	const [audioUrl, setAudioUrl] = useState<string | null>(null);
	const entryLevel = Math.min(useSurface() + 1, 8);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		listHistoryPage({ offset: 0, limit: PAGE_SIZE }).then((page) => {
			if (!cancelled) {
				replaceFirstPage(page);
			}
		});
		const unsubscribe = subscribeBroadcasts({
			onAdded: insertRow,
			onDeleted: removeRow,
			onToggled: toggleRowInStore,
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [replaceFirstPage, insertRow, removeRow, toggleRowInStore, setLoading]);

	const loadNext = (): void => {
		setLoading(true);
		listHistoryPage({ offset: entries.length, limit: PAGE_SIZE }).then(
			(page) => {
				appendPage(page);
				setLoading(false);
			},
		);
	};

	const handlePlay = (id: number): void => {
		setPlayingId(id);
		setAudioUrl(null);
		loadHistoryAudio(id).then((url) => {
			if (url) {
				setAudioUrl(url);
			} else {
				setPlayingId(null);
			}
		});
	};

	const handleDelete = (id: number): void => {
		deleteHistoryRow(id).then((ok) => {
			if (ok) {
				removeRow(id);
				if (playingId === id) {
					setPlayingId(null);
					setAudioUrl(null);
				}
			}
		});
	};

	const handleToggle = (id: number): void => {
		toggleHistoryRow(id).then((saved) => {
			if (saved !== null) {
				toggleRowInStore(id, saved);
			}
		});
	};

	return (
		<div className="flex h-full flex-col gap-2 p-3">
			<header>
				<h1 className="font-semibold text-base">{t("pageTitle")}</h1>
				<p className="text-foreground-secondary text-xs">
					{entries.length} {entries.length === 1 ? "entry" : "entries"}
				</p>
			</header>

			<ul
				className="flex flex-1 flex-col gap-2 overflow-y-auto"
				style={{ touchAction: "pan-y", WebkitOverflowScrolling: "touch" }}
			>
				{entries.map((entry) => {
					const text = effectiveText(entry);
					const tagLabel = historyTagLabel(entry.historyTag);
					const sensitive = hasPrivacyMarkers(entry.privacyMarkers);
					return (
						<li
							className={cn(
								"flex flex-col gap-1 rounded-md border border-border p-2",
								surfaceBg(entryLevel),
							)}
							key={entry.id}
						>
							<div className="flex items-center justify-between text-xs">
								<span className="text-foreground-secondary">
									{formatEntryTimestamp(entry)}
								</span>
								<div className="flex flex-wrap items-center justify-end gap-1">
									{tagLabel ? (
										<Badge variant="secondary">{tagLabel}</Badge>
									) : null}
									{sensitive ? (
										<Badge variant="outline">{SENSITIVE_HISTORY_LABEL}</Badge>
									) : null}
									<div className="flex gap-1">
										<Button
											className="flex items-center gap-1 px-2 py-1 text-xs"
											onClick={() => handlePlay(entry.id)}
											title="Play recording"
										>
											<HugeiconsIcon icon={PlayIcon} size={14} />
										</Button>
										<Button
											className={`flex items-center gap-1 px-2 py-1 text-xs ${
												entry.saved ? "text-warning" : ""
											}`}
											onClick={() => handleToggle(entry.id)}
											title={
												entry.saved ? "Unpin" : "Pin (preserve from retention)"
											}
										>
											<HugeiconsIcon icon={FavouriteIcon} size={14} />
										</Button>
										<Button
											className="flex items-center gap-1 px-2 py-1 text-xs hover:text-error"
											onClick={() => handleDelete(entry.id)}
											title="Delete"
										>
											<HugeiconsIcon icon={Delete02Icon} size={14} />
										</Button>
									</div>
								</div>
							</div>
							<LongPressTranscript text={text} />
							{playingId === entry.id && audioUrl ? (
								<audio
									aria-label="Transcription recording playback"
									autoPlay
									controls
									src={audioUrl}
								>
									<track
										default
										kind="captions"
										label="No captions available"
										srcLang="en"
									/>
								</audio>
							) : null}
						</li>
					);
				})}
			</ul>

			{hasMore ? (
				<Button
					className="self-center px-3 py-1 text-xs"
					disabled={loading}
					onClick={loadNext}
				>
					{loading ? "Loading..." : "Load more"}
				</Button>
			) : null}
		</div>
	);
}

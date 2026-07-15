import {
	CopyCheckIcon,
	Delete02Icon,
	FavouriteIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
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
	onHistoryRowAdded,
	onHistoryRowDeleted,
	onHistoryRowToggled,
} from "@/shared/api/ipc-client";
import { COPY_FEEDBACK_MS, copyToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import {
	computeHighlightRanges,
	type HighlightRange,
} from "@/shared/lib/fuzzy-score";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { useSpeechActivityRef } from "@/shared/lib/use-speech-activity-ref";
import { useLongPress } from "@/shared/lib/use-long-press";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { StaggerReveal } from "@/shared/ui/stagger-reveal";
import { Tooltip } from "@/shared/ui/tooltip";
import { HistorySearchInput } from "@/widgets/transcription-history-settings";

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

interface HistorySearchResult {
	hasMore: boolean;
	transcriptions: Array<{ row: HistoryEntry }>;
}

type HistorySearchCommand = (
	query: string,
	limit: number,
	offset: number,
	kinds: string[],
	dateFrom: number | null,
	dateTo: number | null,
) => Promise<
	| { data: HistorySearchResult; status: "ok" }
	| { error: string; status: "error" }
>;

async function searchHistoryPage(
	query: string,
	offset: number,
): Promise<{ entries: HistoryEntry[]; hasMore: boolean }> {
	const search = (
		commands as unknown as {
			historySearch: HistorySearchCommand;
		}
	).historySearch;
	const response = await search(
		query,
		PAGE_SIZE,
		offset,
		["transcription"],
		null,
		null,
	);
	if (response.status === "error") {
		return { entries: [], hasMore: false };
	}
	return {
		entries: response.data.transcriptions.map((hit) => hit.row),
		hasMore: response.data.hasMore,
	};
}

function LongPressTranscript({
	highlights,
	text,
}: {
	highlights?: HighlightRange[];
	text: string;
}) {
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
		copyToClipboard(text);
		globalThis.navigator?.vibrate?.(10);
		setCopied(true);
		if (copyFeedbackTimerRef.current) {
			clearTimeout(copyFeedbackTimerRef.current);
		}
		copyFeedbackTimerRef.current = setTimeout(
			() => setCopied(false),
			COPY_FEEDBACK_MS,
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
	const highlightedText = highlights?.flatMap((range, index, ranges) => {
		const previousEnd = index === 0 ? 0 : (ranges[index - 1]?.end ?? 0);
		return [
			text.slice(previousEnd, range.start),
			<mark
				className="rounded-[2px] bg-accent/25 text-inherit"
				key={`${range.start}-${range.end}`}
			>
				{text.slice(range.start, range.end)}
			</mark>,
			...(index === ranges.length - 1 ? [text.slice(range.end)] : []),
		];
	});

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
				{highlightedText ?? text}
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
	const [query, setQuery] = useState("");
	const [searchEntries, setSearchEntries] = useState<HistoryEntry[]>([]);
	const [searchHasMore, setSearchHasMore] = useState(false);
	const [searchLoading, setSearchLoading] = useState(false);
	const searchRequestSeq = useRef(0);
	const [animatedEntryIds, setAnimatedEntryIds] = useState<Set<number>>(
		() => new Set(),
	);
	const speechActivityRef = useSpeechActivityRef();
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
			onAdded: (entry) => {
				insertRow(entry);
				if (speechActivityRef.current) {
					setAnimatedEntryIds((current) => {
						if (current.has(entry.id)) {
							return current;
						}
						const next = new Set(current);
						next.add(entry.id);
						return next;
					});
				}
			},
			onDeleted: removeRow,
			onToggled: toggleRowInStore,
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [
		replaceFirstPage,
		insertRow,
		removeRow,
		toggleRowInStore,
		setLoading,
		speechActivityRef,
	]);

	useEffect(() => {
		const normalizedQuery = query.trim();
		const seq = ++searchRequestSeq.current;
		if (!normalizedQuery) {
			setSearchEntries([]);
			setSearchHasMore(false);
			setSearchLoading(false);
			return;
		}
		setSearchLoading(true);
		searchHistoryPage(normalizedQuery, 0)
			.catch(() => ({ entries: [], hasMore: false }))
			.then((page) => {
				if (searchRequestSeq.current !== seq) {
					return;
				}
				setSearchEntries(page.entries);
				setSearchHasMore(page.hasMore);
				setSearchLoading(false);
			});
	}, [query]);

	const searching = query.trim().length > 0;
	const displayedEntries = searching ? searchEntries : entries;
	const displayedHasMore = searching ? searchHasMore : hasMore;
	const displayedLoading = searching ? searchLoading : loading;

	const loadNext = (): void => {
		if (searching) {
			const seq = searchRequestSeq.current;
			setSearchLoading(true);
			searchHistoryPage(query.trim(), searchEntries.length)
				.catch(() => ({ entries: [], hasMore: false }))
				.then((page) => {
					if (searchRequestSeq.current !== seq) {
						return;
					}
					setSearchEntries((current) => [...current, ...page.entries]);
					setSearchHasMore(page.hasMore);
					setSearchLoading(false);
				});
			return;
		}
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
				setSearchEntries((current) =>
					current.filter((entry) => entry.id !== id),
				);
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
				setSearchEntries((current) =>
					current.map((entry) =>
						entry.id === id ? { ...entry, saved } : entry,
					),
				);
			}
		});
	};

	return (
		<div className="flex h-full flex-col gap-2 p-3">
			<header className="flex flex-col gap-2">
				<h1 className="font-semibold text-base">{t("pageTitle")}</h1>
				<p className="text-foreground-secondary text-xs">
					{displayedEntries.length}{" "}
					{displayedEntries.length === 1 ? "entry" : "entries"}
				</p>
				<HistorySearchInput
					count={searchEntries.length}
					hasMore={searchHasMore}
					onQueryChange={setQuery}
				/>
			</header>

			<ul
				className="flex flex-1 flex-col gap-2 overflow-y-auto"
				style={{ touchAction: "pan-y", WebkitOverflowScrolling: "touch" }}
			>
				{displayedEntries.map((entry) => {
					const text = effectiveText(entry);
					const highlights = searching
						? computeHighlightRanges(text, query)
						: undefined;
					const tagLabel = historyTagLabel(entry.historyTag);
					const sensitive = hasPrivacyMarkers(entry.privacyMarkers);
					const animateEntry = animatedEntryIds.has(entry.id);
					return (
						<li
							className={cn(
								"flex flex-col gap-1 rounded-md border border-border p-2",
								surfaceBg(entryLevel),
							)}
							key={entry.id}
						>
							<StaggerReveal
								active={animateEntry}
								contentClassName="flex flex-col gap-1"
								onComplete={() =>
									setAnimatedEntryIds((current) => {
										if (!current.has(entry.id)) {
											return current;
										}
										const next = new Set(current);
										next.delete(entry.id);
										return next;
									})
								}
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
											<Tooltip content="Play recording">
												<Button
													aria-label="Play recording"
													className="flex items-center gap-1 px-2 py-1 text-xs"
													onClick={() => handlePlay(entry.id)}
												>
													<HugeiconsIcon icon={PlayIcon} size={14} />
												</Button>
											</Tooltip>
											<Tooltip
												content={
													entry.saved
														? "Unpin"
														: "Pin (preserve from retention)"
												}
											>
												<Button
													aria-label={entry.saved ? "Unpin" : "Pin"}
													className={`flex items-center gap-1 px-2 py-1 text-xs ${
														entry.saved ? "text-warning" : ""
													}`}
													onClick={() => handleToggle(entry.id)}
												>
													<HugeiconsIcon icon={FavouriteIcon} size={14} />
												</Button>
											</Tooltip>
											<Tooltip content="Delete">
												<Button
													aria-label="Delete"
													className="flex items-center gap-1 px-2 py-1 text-xs hover:text-error"
													onClick={() => handleDelete(entry.id)}
												>
													<HugeiconsIcon icon={Delete02Icon} size={14} />
												</Button>
											</Tooltip>
										</div>
									</div>
								</div>
								<LongPressTranscript
									{...(highlights ? { highlights } : {})}
									text={text}
								/>
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
							</StaggerReveal>
						</li>
					);
				})}
				{searching && !searchLoading && displayedEntries.length === 0 ? (
					<li className="py-8 text-center text-foreground-muted text-sm">
						{t("searchNoResults")}
					</li>
				) : null}
			</ul>

			{displayedHasMore ? (
				<Button
					className="self-center px-3 py-1 text-xs"
					disabled={displayedLoading}
					onClick={loadNext}
				>
					{displayedLoading ? "Loading..." : "Load more"}
				</Button>
			) : null}
		</div>
	);
}

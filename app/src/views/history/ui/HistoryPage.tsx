import { Delete02Icon, FavouriteIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
	deleteHistoryRow,
	effectiveText,
	formatEntryTimestamp,
	type HistoryEntry,
	listHistoryPage,
	loadHistoryAudio,
	toggleHistoryRow,
	useHistoryViewStore,
} from "@/entities/transcription-history";
import { IPC } from "@/shared/api/ipc-channels";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";

function subscribeBroadcasts(callbacks: {
	onAdded: (entry: HistoryEntry) => void;
	onDeleted: (id: number) => void;
	onToggled: (id: number, saved: boolean) => void;
}): () => void {
	// `window.electronAPI` is typed globally (src/electron.d.ts) and injected by
	// the preload bridge; guard for non-Electron contexts (tests) at runtime.
	const api = window.electronAPI;
	if (!api) {
		return () => undefined;
	}
	const offAdded = api.on(IPC.HISTORY_ROW_ADDED, (entry: unknown) => {
		callbacks.onAdded(entry as HistoryEntry);
	});
	const offDeleted = api.on(IPC.HISTORY_ROW_DELETED, (payload: unknown) => {
		const p = payload as { id?: number };
		if (typeof p?.id === "number") {
			callbacks.onDeleted(p.id);
		}
	});
	const offToggled = api.on(IPC.HISTORY_ROW_TOGGLED, (payload: unknown) => {
		const p = payload as { id?: number; saved?: boolean };
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

export function HistoryPage() {
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
		listHistoryPage({ offset: entries.length, limit: PAGE_SIZE }).then((page) => {
			appendPage(page);
			setLoading(false);
		});
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
				<h1 className="font-semibold text-base">Transcription history</h1>
				<p className="text-foreground-secondary text-xs">
					{entries.length} {entries.length === 1 ? "entry" : "entries"}
				</p>
			</header>

			<ul className="flex flex-1 flex-col gap-2 overflow-y-auto">
				{entries.map((entry) => (
					<li
						className={cn(
							"flex flex-col gap-1 rounded-md border border-border p-2",
							surfaceBg(entryLevel)
						)}
						key={entry.id}
					>
						<div className="flex items-center justify-between text-xs">
							<span className="text-foreground-secondary">{formatEntryTimestamp(entry)}</span>
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
									title={entry.saved ? "Unpin" : "Pin (preserve from retention)"}
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
						<p className="text-sm">{effectiveText(entry)}</p>
						{playingId === entry.id && audioUrl ? (
							<audio aria-label="Transcription recording playback" autoPlay controls src={audioUrl}>
								<track default kind="captions" label="No captions available" srcLang="en" />
							</audio>
						) : null}
					</li>
				))}
			</ul>

			{hasMore ? (
				<Button className="self-center px-3 py-1 text-xs" disabled={loading} onClick={loadNext}>
					{loading ? "Loading..." : "Load more"}
				</Button>
			) : null}
		</div>
	);
}

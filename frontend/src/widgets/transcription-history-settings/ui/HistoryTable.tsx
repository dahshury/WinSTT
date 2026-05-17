"use client";

import { ContextMenu } from "@base-ui/react/context-menu";
import { useTranslations } from "next-intl";
import {
	formatDuration,
	formatWpm,
	type TranscriptionHistoryEntry,
	wordsPerMinute,
} from "@/entities/transcription-history";
import { clipboardWriteText } from "@/shared/api/ipc-client";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceClasses, surfaceHighlightedBg } from "@/shared/lib/surface";
import {
	Table,
	TableBody,
	TableCell,
	TableEmpty,
	TableHead,
	TableHeader,
	TableRow,
} from "@/shared/ui/table";

interface HistoryTableProps {
	entries: TranscriptionHistoryEntry[];
}

const MAX_BODY_HEIGHT_PX = 480;
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
	index: number;
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

function HistoryRow({ entry, copyLabel, copyOriginalLabel, index }: HistoryRowProps) {
	const hasOriginal = entry.originalText !== undefined && entry.originalText.length > 0;
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger
				render={
					<TableRow index={index}>
						<TableCell className="w-[170px] whitespace-nowrap font-mono text-foreground-secondary text-xs-tight tabular-nums">
							{formatTimestamp(entry.timestamp)}
						</TableCell>
						<TableCell className="w-[68px] text-right tabular-nums">{entry.wordCount}</TableCell>
						<TableCell className="w-[88px] text-right tabular-nums">
							{formatDuration(entry.durationMs)}
						</TableCell>
						<TableCell className="w-[68px] text-right tabular-nums">
							{formatWpm(wordsPerMinute(entry.wordCount, entry.durationMs))}
						</TableCell>
						<TableCell className="truncate text-foreground" title={entry.text}>
							{entry.text}
						</TableCell>
					</TableRow>
				}
			/>
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
	// Most recent first; entries are stored chronologically by the main process.
	const sorted = [...entries].reverse();
	const copyLabel = t("copy");
	const copyOriginalLabel = t("copyOriginal");

	return (
		<div className="overflow-y-auto overscroll-contain" style={{ maxHeight: MAX_BODY_HEIGHT_PX }}>
			<Table containerClassName="rounded border border-border bg-surface-tertiary overflow-hidden">
				<TableHeader>
					<TableRow>
						<TableHead className="w-[170px] whitespace-nowrap">{t("colTime")}</TableHead>
						<TableHead className="w-[68px] text-right">{t("colWords")}</TableHead>
						<TableHead className="w-[88px] text-right">{t("colDuration")}</TableHead>
						<TableHead className="w-[68px] text-right">{t("colWpm")}</TableHead>
						<TableHead>{t("colText")}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{sorted.length === 0 ? (
						<TableEmpty colSpan={5}>{t("tableEmpty")}</TableEmpty>
					) : (
						sorted.map((entry, idx) => (
							<HistoryRow
								copyLabel={copyLabel}
								copyOriginalLabel={copyOriginalLabel}
								entry={entry}
								index={idx}
								key={entry.id}
							/>
						))
					)}
				</TableBody>
			</Table>
		</div>
	);
}

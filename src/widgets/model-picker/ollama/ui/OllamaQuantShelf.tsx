"use client";

import { BinaryCodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { OllamaLibraryTag, OllamaPullProgress } from "@/shared/api/models";
import { Tooltip as ContentTooltip } from "@/shared/ui/tooltip";
import { QuantShelf } from "../../core/model-card/QuantShelf";
import type {
	QuantDownloadAction,
	QuantDownloadSnapshot,
	QuantShelfEntry,
} from "../../core/model-card/quant-shelf-types";
import { formatOllamaDisplayName } from "../lib/family-helpers";
import {
	findInstalledOllamaTag,
	isSameOllamaTag,
	isTagInstalled,
	libraryBaseSlug,
	pruneToShownQuants,
	quantBadgeCacheState,
	quantBadgeLabel,
	tagsForParamSize,
} from "../lib/quant-shelf-helpers";
import type {
	OllamaFitInfo,
	PausedPullState,
	QuantBadgeState,
} from "./ollama-selector-types";

// ── Quantization precision shelf ──────────────────────────────────────
//
// The Ollama analogue of the STT picker's precision shelf
// (`stt/ui/SttModelCard.tsx` → PrecisionGroup): a recessed strip of quant
// BADGES with click-to-download folded into each badge. ONE badge per library
// tag matching the card's parameter size. Each badge's on-disk state drives its
// behaviour, mirroring the STT `QuantOptionButton`:
//   - installed  → muted-emerald, click selects the model, trailing trash deletes
//   - active pull → progress fill + pause/resume + cancel; body inert
//   - paused      → muted-amber, resume
//   - not on disk → neutral; the badge IS the download button (hover → glyph)
// Ollama tags normalize into shared QuantShelf entries, so STT, TTS, and
// Ollama share the same badge chrome and download controls.

/**
 * The percent the badge renders for a pull/paused frame. Prefers the ACTUAL
 * downloaded bytes over the quant's KNOWN full size (`fullSizeBytes`) so the bar
 * is one continuous, monotonic measure of the WHOLE download — every layer/file
 * counted against a fixed denominator. Ollama streams its layers sequentially and
 * its own aggregate `percent` uses a denominator that GROWS as each new layer is
 * announced (so the raw percent dips when a file starts); anchoring to the known
 * full size avoids that "reset". Falls back to the reported `percent` only when
 * the byte counts or the full size aren't known yet, and pins to 100 on success.
 */
function ollamaProgressPercent(
	progress: OllamaPullProgress,
	fullSizeBytes: number | null,
): number {
	if (progress.status === "success") {
		return 100;
	}
	if (
		fullSizeBytes != null &&
		fullSizeBytes > 0 &&
		typeof progress.completed === "number"
	) {
		return Math.max(
			0,
			Math.min(100, Math.round((progress.completed / fullSizeBytes) * 100)),
		);
	}
	return Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
}

function deriveQuantBadgeState(
	pull: OllamaPullProgress | undefined,
	paused: PausedPullState | undefined,
	installed: boolean,
	fullSizeBytes: number | null,
): QuantBadgeState {
	const isDownloading = pull !== undefined;
	const cacheState = quantBadgeCacheState({
		installed,
		paused: paused !== undefined,
	});
	let progressPercent: number | null = null;
	if (pull) {
		progressPercent = ollamaProgressPercent(pull, fullSizeBytes);
	} else if (paused) {
		progressPercent = ollamaProgressPercent(paused.progress, fullSizeBytes);
	}
	return { cacheState, isDownloading, progressPercent };
}

function isForceKeptOllamaTag(
	forceKeepNames: ReadonlySet<string> | undefined,
	name: string,
): boolean {
	if (!forceKeepNames) {
		return false;
	}
	for (const forceKeepName of forceKeepNames) {
		if (isSameOllamaTag(forceKeepName, name)) {
			return true;
		}
	}
	return false;
}

function findRecordKeyByOllamaTag<T>(
	record: Readonly<Record<string, T>>,
	name: string,
): string | undefined {
	if (record[name] !== undefined) {
		return name;
	}
	for (const key of Object.keys(record)) {
		if (isSameOllamaTag(key, name)) {
			return key;
		}
	}
	return undefined;
}

/** Human status line for one Ollama tag inside the shared quant badge tooltip. */
function ollamaQuantCacheStatus(state: QuantBadgeState): string {
	let status = "Not downloaded";
	if (state.cacheState === "cached") {
		status = "Installed";
	} else if (state.isDownloading) {
		status = `Downloading ${state.progressPercent ?? 0}%`;
	} else if (state.cacheState === "partial") {
		status = `Paused at ${state.progressPercent ?? 0}%`;
	}
	return status;
}

function activePullSnapshot(
	progressPercent: number | null,
	downloadedBytes: number | null,
	totalBytes: number | null,
): QuantDownloadSnapshot {
	// Carry the REAL byte counts (Ollama's aggregate `completed` + the quant's full
	// size) so the shared tooltip reports the actual download size instead of
	// falling back to the scraped label, and the bar fills against the full total.
	return {
		downloadedBytes: downloadedBytes ?? 0,
		totalBytes: totalBytes ?? 0,
		progress: progressPercent,
		paused: false,
	};
}

function buildOllamaQuantEntries({
	getFit,
	installedNames,
	pausedPulls,
	pulls,
	selectedName,
	tags,
}: Pick<
	OllamaQuantShelfProps,
	| "getFit"
	| "installedNames"
	| "pausedPulls"
	| "pulls"
	| "selectedName"
	| "tags"
>): QuantShelfEntry[] {
	return tags.map((tag) => {
		const installedName = findInstalledOllamaTag(installedNames, tag.name);
		const pullName = findRecordKeyByOllamaTag(pulls, tag.name);
		const pausedName = findRecordKeyByOllamaTag(pausedPulls, tag.name);
		const actionName = pullName ?? pausedName ?? installedName ?? tag.name;
		const installed = installedName !== undefined;
		const pull = pullName ? pulls[pullName] : undefined;
		const paused = pausedName ? pausedPulls[pausedName] : undefined;
		// The quant's KNOWN full download size: the scraped tag size (Ollama's
		// reported total for this exact tag, covering all its layers), falling back
		// to the live aggregate total while a pull is in flight. Drives the badge
		// progress denominator AND the displayed/tooltip size so they agree.
		const fullSizeBytes = tag.sizeBytes ?? pull?.total ?? null;
		const state = deriveQuantBadgeState(pull, paused, installed, fullSizeBytes);
		const isPaused = state.cacheState === "partial" && !state.isDownloading;
		const canStartDownload = !(
			state.isDownloading ||
			installed ||
			state.cacheState === "partial"
		);
		const fit = fullSizeBytes ? getFit?.(fullSizeBytes) : undefined;
		return {
			actionQuant: actionName,
			cacheProgress:
				!state.isDownloading && state.progressPercent !== null
					? state.progressPercent / 100
					: null,
			cacheState: state.cacheState,
			cacheStatusLabel: ollamaQuantCacheStatus(state),
			canDelete: installed && !state.isDownloading,
			canResumeDownload: isPaused,
			canStartDownload,
			download: state.isDownloading
				? activePullSnapshot(
						state.progressPercent,
						pull?.completed ?? null,
						fullSizeBytes,
					)
				: undefined,
			downloadSizeBytes: fullSizeBytes,
			...(tag.sizeLabel ? { downloadSizeLabel: tag.sizeLabel } : {}),
			isActive: isSameOllamaTag(selectedName, tag.name) && installed,
			isRecommended: false,
			label: quantBadgeLabel(tag),
			mono: true,
			tooltip: fit && !fit.fits ? "May not fit on your hardware." : "",
			value: installedName ?? tag.name,
		};
	});
}

function isDefaultLikeQuantLabel(label: string): boolean {
	const normalized = label.trim().toLowerCase();
	return normalized === "default" || normalized === "latest";
}

function quantEntryPreferenceScore(entry: QuantShelfEntry): number {
	let score = 0;
	if (!isDefaultLikeQuantLabel(entry.label)) {
		score += 4;
	}
	if (entry.cacheState === "cached") {
		score += 3;
	}
	if (entry.download !== undefined || entry.canResumeDownload === true) {
		score += 2;
	}
	if (
		entry.downloadSizeBytes !== null &&
		entry.downloadSizeBytes !== undefined
	) {
		score += 1;
	}
	return score;
}

function preferOllamaQuantEntry(
	current: QuantShelfEntry,
	candidate: QuantShelfEntry,
): QuantShelfEntry {
	return quantEntryPreferenceScore(candidate) >
		quantEntryPreferenceScore(current)
		? candidate
		: current;
}

function dedupeOllamaQuantEntries(
	entries: readonly QuantShelfEntry[],
): QuantShelfEntry[] {
	const result: QuantShelfEntry[] = [];
	const indexByKey = new Map<string, number>();
	for (const entry of entries) {
		const key = entry.value || "default";
		const index = indexByKey.get(key);
		if (index === undefined) {
			indexByKey.set(key, result.length);
			result.push(entry);
			continue;
		}
		const current = result[index];
		if (current) {
			result[index] = preferOllamaQuantEntry(current, entry);
		}
	}
	return result;
}

function handleOllamaQuantAction({
	action,
	name,
	onDiscard,
	onPull,
	onResume,
	onStop,
}: {
	action: QuantDownloadAction;
	name: string;
	onDiscard: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onStop: (name: string) => void;
}): void {
	if (action === "start") {
		onPull(name);
	} else if (action === "pause") {
		onStop(name);
	} else if (action === "resume") {
		onResume(name);
	} else {
		onDiscard(name);
	}
}

interface OllamaQuantShelfProps {
	getFit: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	/** Explicit tags this row must keep visible even if they are not part of the
	 *  canonical quant ladder. Used for arbitrary user-typed tags. */
	forceKeepNames?: ReadonlySet<string> | undefined;
	installedNames: ReadonlySet<string>;
	onDiscard: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onSelect: (name: string) => void;
	onStop: (name: string) => void;
	/** The model's parameter size (`4b`, `27b`) — the shelf shows only the quant
	 *  badges for THIS size. Empty/undefined shows every quant the tag list has. */
	paramSize: string | null | undefined;
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pulls: Readonly<Record<string, OllamaPullProgress>>;
	/** Currently-selected (active) model name — drives the accent badge. */
	selectedName: string | undefined;
	/** All library tags for the model's base slug. Sliced to `paramSize` here. */
	tags: readonly OllamaLibraryTag[];
}

/** The recessed quant shelf: a leading binary glyph + a wrap of quant badges,
 *  one per tag matching `paramSize`. Mirrors the STT picker's `PrecisionGroup`.
 *  Returns null when there are no tags to show (the caller renders nothing). */
export function OllamaQuantShelf({
	tags,
	paramSize,
	installedNames,
	selectedName,
	pulls,
	pausedPulls,
	getFit,
	forceKeepNames,
	onSelect,
	onPull,
	onStop,
	onResume,
	onDiscard,
}: OllamaQuantShelfProps) {
	// Slice to the card's param size, then prune the dominated/irrelevant quants
	// down to the canonical ladder — keeping anything the user has on disk, is
	// pulling/paused, or has selected so it never disappears mid-flight.
	const visibleTags = pruneToShownQuants(
		tagsForParamSize(tags, paramSize),
		(name) =>
			isForceKeptOllamaTag(forceKeepNames, name) ||
			isTagInstalled(installedNames, name) ||
			pulls[name] !== undefined ||
			pausedPulls[name] !== undefined ||
			isSameOllamaTag(selectedName, name),
	);
	if (visibleTags.length === 0) {
		return null;
	}
	const shelfModelDisplayName = formatOllamaDisplayName(
		libraryBaseSlug(visibleTags[0]?.name ?? selectedName ?? "ollama"),
	);
	const entries = dedupeOllamaQuantEntries(
		buildOllamaQuantEntries({
			getFit,
			installedNames,
			pausedPulls,
			pulls,
			selectedName,
			tags: visibleTags,
		}),
	);
	return (
		<div className="flex flex-wrap items-center gap-2">
			<ContentTooltip
				content="Quantization — the numeric precision of the model's weights. Lower precision (q4 / q5) loads faster and uses less RAM/VRAM at a small quality cost; higher precision (q8 / fp16) is the most faithful but heaviest. Click a badge to download it, or select an installed one."
				side="top"
			>
				<span className="inline-flex shrink-0 items-center font-medium text-[10px] text-foreground-muted uppercase tracking-wide">
					<HugeiconsIcon className="size-3" icon={BinaryCodeIcon} />
				</span>
			</ContentTooltip>
			<QuantShelf
				entries={entries}
				modelDisplayName={shelfModelDisplayName}
				modelId={selectedName ?? "ollama"}
				onDownloadAction={(action, _modelId, name) =>
					handleOllamaQuantAction({
						action,
						name,
						onDiscard,
						onPull,
						onResume,
						onStop,
					})
				}
				onRequestDeleteQuant={(_modelId, name) => onDiscard(name)}
				onSelect={(_modelId, name) => onSelect(name)}
				showIcon={false}
			/>
		</div>
	);
}

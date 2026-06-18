"use client";

import { BinaryCodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { OllamaLibraryTag, OllamaPullProgress } from "@/shared/api/models";
import { Tooltip as ContentTooltip } from "@/shared/ui/tooltip";
import {
	type QuantDownloadAction,
	type QuantDownloadSnapshot,
	QuantShelf,
	type QuantShelfEntry,
} from "../../core/model-card/QuantShelf";
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

function deriveQuantBadgeState(
	pull: OllamaPullProgress | undefined,
	paused: PausedPullState | undefined,
	installed: boolean,
): QuantBadgeState {
	const isDownloading = pull !== undefined;
	const cacheState = quantBadgeCacheState({
		installed,
		paused: paused !== undefined,
	});
	let progressPercent: number | null = null;
	if (pull) {
		progressPercent = Math.max(0, Math.min(100, Math.round(pull.percent ?? 0)));
	} else if (paused) {
		progressPercent = Math.max(
			0,
			Math.min(100, Math.round(paused.progress.percent ?? 0)),
		);
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
): QuantDownloadSnapshot {
	return {
		downloadedBytes: 0,
		totalBytes: 0,
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
		const state = deriveQuantBadgeState(pull, paused, installed);
		const isPaused = state.cacheState === "partial" && !state.isDownloading;
		const canStartDownload = !(
			state.isDownloading ||
			installed ||
			state.cacheState === "partial"
		);
		const fit = tag.sizeBytes ? getFit?.(tag.sizeBytes) : undefined;
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
				? activePullSnapshot(state.progressPercent)
				: undefined,
			downloadSizeBytes: tag.sizeBytes ?? null,
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

/**
 * Card-BODY click handler for a non-installed (`as="div"`) recommended/library
 * card: it selects/pulls the model's AUTO / recommended (default) tag — the bare
 * `<name>` / `<name>:<size>` with no precision suffix. Mirrors the STT picker,
 * where the "Auto" badge was removed and a card-body click selects the
 * recommended precision; the explicit per-quant badges keep their own clicks
 * (they `stopPropagation`, so they never reach here).
 *
 * The action matches a quant badge's own routing for the default tag: select it
 * when it's already installed, resume a paused pull, otherwise start the pull.
 * Returns `undefined` when the tag is actively downloading (no body action while
 * the default is in flight — the user uses the shelf controls to pause/cancel).
 */
export { InstalledQuantShelf } from "./InstalledQuantShelf";
export { LazyQuantShelf } from "./LazyQuantShelf";

/** Library slug whose sibling tags to fetch + render (`gemma3`). */
/** Tags to merge with fetched library tags. */
/** Param size the card represents (`4b`). Filters the tag list. */
/** Rendered until tags load — keeps a single badge visible so the shelf
 *  doesn't flicker empty for an installed model whose siblings are en route. */

/** Lazily fetches the base-slug tags (idempotent in the store) and renders the
 *  quant shelf once they're available. Used by every card type so installed,
 *  recommended, and library rows all show the same precision strip. */

/** Synthesize a one-tag list standing in for an installed model whose sibling
 *  library tags haven't loaded yet — the model's OWN tag, so the shelf shows at
 *  least the installed quant (muted-emerald, selectable) without flickering empty
 *  while {@link LazyQuantShelf} fetches the rest. Optional fields are omitted
 *  (not set to `undefined`) so the tag satisfies `exactOptionalPropertyTypes`. */

/** The installed model's param size, as the token the library TAGS carry
 *  (`gemma3:4b` → `4b`). Ollama reports `details.parameterSize` as `4.3B`/`4.0B`
 *  — the rounded real param count, which never equals the tag token `4b` — so we
 *  parse the token out of the name and only fall back to the structured field
 *  when the name has no token (a bare `gemma3`). */

/** The shelf rendered for an installed card. Lazily scrapes the family's sibling
 *  tags (gated to a few concurrent requests in the main process, so a picker-open
 *  burst can't overwhelm ollama.com) and renders every quant for the model's
 *  param size — the installed one tinted as cached/selectable, the rest as
 *  click-to-pull. Until the tags load (or if the scrape fails) the model's own
 *  quant shows as a placeholder so the shelf never flickers empty. */

// forget-paused-pull handler — mirrors STT, whose delete hits a real delete.

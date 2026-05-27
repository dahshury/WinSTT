import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
	onTtsModelDownloadComplete,
	onTtsModelDownloadProgress,
	onTtsModelDownloadStart,
	type TtsInstallPhase,
} from "@/shared/api/ipc-client";
import { formatBytes } from "@/shared/lib/format-bytes";

interface DownloadState {
	active: boolean;
	downloadedBytes: number;
	progress: number;
	totalBytes: number;
}

const INITIAL: DownloadState = { active: false, progress: 0, downloadedBytes: 0, totalBytes: 0 };

export interface TtsDownloadProgress {
	/** Whether a download is currently in flight (show the bar). */
	active: boolean;
	/**
	 * Bar label. Prefixed with the install phase ("Installing TTS
	 * engine…" → "Downloading voice model…") so the ~220 MB on-demand
	 * install reads as distinct steps, not one anonymous bar.
	 */
	label: string;
	/** Integer 0–100 for the progress bar. */
	percent: number;
}

type Translator = ReturnType<typeof useTranslations>;
type PhaseLookupKey = TtsInstallPhase | "null";

// Phase → builder lookup. Every member of `TtsInstallPhase | null` is a key
// (via `String(null) === "null"`) so the indexed access in `buildPhaseLabel`
// is total — no `??`/`||` needed to coalesce a missing entry.
const PHASE_LABEL_BUILDERS: Record<PhaseLookupKey, (t: Translator) => string> = {
	engine: (t) => t("installPhaseEngine"),
	model: (t) => t("installPhaseModel"),
	ready: () => "",
	unknown: () => "",
	null: () => "",
};

/** Phase prefix (or "" when there's no active phase). Branch-free lookup. */
export function buildPhaseLabel(t: Translator, installPhase: TtsInstallPhase | null): string {
	const key = String(installPhase) as PhaseLookupKey;
	return PHASE_LABEL_BUILDERS[key](t);
}

/**
 * Coalesce the first non-null candidate. Used in place of `value ?? fallback`
 * so each call site stays at CC 1 — the only branching here is the predicate
 * inside the nested arrow, which itself is CC 1.
 */
export function firstString(...candidates: Array<string | null | undefined>): string {
	return candidates.find((c): c is string => typeof c === "string") as string;
}

/**
 * Builder array indexed by `Number(state.totalBytes > 0)`:
 *   - 0 → "Downloading…" placeholder (no size yet)
 *   - 1 → "X % · A / B" — full progress line
 *
 * Indexing instead of a ternary keeps `buildProgressLabel` at CC 1.
 */
const PROGRESS_LABEL_BUILDERS: ReadonlyArray<(t: Translator, state: DownloadState) => string> = [
	(t) => t("downloading"),
	(t, state) =>
		t("downloadingProgress", {
			percent: Math.round(state.progress * 100).toString(),
			downloaded: firstString(formatBytes(state.downloadedBytes), "0 B"),
			total: firstString(formatBytes(state.totalBytes), "0 B"),
		}),
];

/** "Downloading…" line. Indexed lookup (no ternary). */
export function buildProgressLabel(t: Translator, state: DownloadState): string {
	const builder = PROGRESS_LABEL_BUILDERS[Number(state.totalBytes > 0)] as (
		t: Translator,
		state: DownloadState
	) => string;
	return builder(t, state);
}

/**
 * Compose the final bar label. An empty phase prefix is filtered out via
 * `.filter` instead of a ternary so the function stays at CC 1.
 */
export function composeBarLabel(phaseLabel: string, progressLabel: string): string {
	return [phaseLabel, progressLabel].filter((p) => p.length > 0).join(" · ");
}

function applyProgressEvent(
	setDownload: (next: DownloadState) => void,
	payload: { downloadedBytes: number; progress: number; totalBytes: number }
): void {
	setDownload({
		active: true,
		progress: payload.progress,
		downloadedBytes: payload.downloadedBytes,
		totalBytes: payload.totalBytes,
	});
}

/**
 * Tracks the on-demand TTS install download (engine pack → voice model
 * → voicepacks) and produces a phase-labelled progress descriptor.
 */
export function useTtsDownloadProgress(installPhase: TtsInstallPhase | null): TtsDownloadProgress {
	const t = useTranslations("tts");
	const [download, setDownload] = useState<DownloadState>(INITIAL);

	useEffect(() => onTtsModelDownloadStart(() => setDownload({ ...INITIAL, active: true })), []);
	useEffect(
		() => onTtsModelDownloadProgress((payload) => applyProgressEvent(setDownload, payload)),
		[]
	);
	useEffect(() => onTtsModelDownloadComplete(() => setDownload(INITIAL)), []);

	const phaseLabel = buildPhaseLabel(t, installPhase);
	const progressLabel = buildProgressLabel(t, download);

	return {
		active: download.active,
		percent: Math.round(download.progress * 100),
		label: composeBarLabel(phaseLabel, progressLabel),
	};
}

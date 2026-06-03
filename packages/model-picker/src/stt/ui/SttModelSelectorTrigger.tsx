"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import { type ModelInfo, useModelSwapStore } from "@/entities/model-catalog";
import { Button } from "@/shared/ui/button";
import { PulseDot } from "@/shared/ui/pulse-dot";
import {
	buildSwitchingClassName,
	SwapSweepBar,
	SwitchingFromToRow,
	SwitchingPill,
} from "@/shared/ui/switching-trigger";
import { publicAsset } from "../../lib/public-asset";
import { getAuthorLabel, getFamilyConfig, variantDisplayName } from "../lib/family-helpers";

export interface SttModelSelectorTriggerProps {
	/** Models known to the parent picker. Used to resolve the previous-model
	 *  id (held in the swap store) back to a `ModelInfo` for the `from` leg
	 *  of the in-flight transition view. */
	catalog: readonly ModelInfo[];
	disabled: boolean;
	/** Live model-download progress observed by the consumer (parsed out of
	 *  the renderer's `useDownloadStore`). When the in-flight download target
	 *  matches the in-flight swap target, the trigger replaces the
	 *  `[from → ◌ → to]` "Switching" view with a download-aware
	 *  `[currently selected] · Downloading X · 23%` view — so the user sees
	 *  the picker remain on the model that's actually loaded right now,
	 *  while still being told the new variant is on its way.
	 *
	 *  ``count`` and ``averagePercent`` describe the full aggregate across
	 *  ``quantDownloads`` plus the legacy singleton slot. ``count >= 2``
	 *  switches the trigger to the multi-download "Downloading N items · X%"
	 *  body so parallel per-quant downloads collapse into one readable chip
	 *  instead of fighting for the same single-line slot. ``modelId`` /
	 *  ``percent`` describe the highest-progress single download — used by
	 *  the single-download view and as the swap-target match probe.
	 *
	 *  The model-picker package is self-contained (no `@/shared/*` imports
	 *  by design — see `package.json`); the consumer is responsible for
	 *  wiring the store. ``percent`` and ``averagePercent`` are ``null``
	 *  when no chunk-progress event has landed yet (indeterminate start). */
	downloadProgress?: {
		averagePercent?: number | null;
		count?: number;
		modelId: string;
		percent: number | null;
	} | null;
	/** Which swap-store slot this trigger should react to. */
	kind: "main" | "realtime";
	open: boolean;
	placeholder: string;
	selectedModel: ModelInfo | undefined;
}

/** Author/maker chip — logo + label (e.g. "NVIDIA", "OpenAI"). Mirrors the
 *  Ollama selector's PublisherChip so triggers across pickers feel uniform. */
function AuthorChip({ family, muted = false }: { family: ModelInfo["family"]; muted?: boolean }) {
	const config = getFamilyConfig(family);
	const author = getAuthorLabel(family);
	const tone = muted
		? "border-border/60 bg-surface-secondary/40 text-foreground-dim"
		: "border-border bg-surface-secondary/60 text-foreground-secondary";
	return (
		<span
			className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium text-[10px] leading-none ${tone}`}
		>
			{config.logoSrc ? (
				<img
					alt=""
					className={`size-3 rounded-[2px] object-contain ${muted ? "opacity-60" : ""}`}
					height={12}
					src={publicAsset(config.logoSrc)}
					width={12}
				/>
			) : (
				<HugeiconsIcon className="size-3" icon={config.icon} />
			)}
			{author}
		</span>
	);
}

function SelectedContent({
	selectedModel,
	peers,
}: {
	selectedModel: ModelInfo;
	peers?: readonly ModelInfo[] | undefined;
}) {
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<AuthorChip family={selectedModel.family} />
			<span className="truncate font-medium text-body text-foreground leading-tight tracking-tight">
				{variantDisplayName(selectedModel, peers)}
			</span>
		</div>
	);
}

/** STT-flavored chip+name pair used as a slot inside `SwitchingFromToRow`. */
function SttModelLabel({
	model,
	side,
	peers,
}: {
	model: ModelInfo;
	side: "from" | "to";
	peers?: readonly ModelInfo[] | undefined;
}) {
	if (side === "from") {
		return (
			<>
				<AuthorChip family={model.family} muted />
				<span className="min-w-0 max-w-[8rem] truncate font-medium text-body text-foreground-dim leading-tight tracking-tight line-through decoration-foreground-dim/40">
					{variantDisplayName(model, peers)}
				</span>
			</>
		);
	}
	return (
		<>
			<AuthorChip family={model.family} />
			<span className="min-w-0 truncate font-semibold text-accent text-body leading-tight tracking-tight">
				{variantDisplayName(model, peers)}
			</span>
		</>
	);
}

/** Downloading body — shows the selected (still-active) model on the left
 *  and either "Downloading <target> · 23%" (single download) or
 *  "Downloading N items · 47%" (multiple in-flight downloads) on the right.
 *  Distinct from the `[from → ◌ → to]` switching view because here the
 *  picker is NOT in a swap window: bytes are still flowing into the HF
 *  cache and the server hasn't restarted yet. The user can still pick
 *  another already-cached model from the popup — kicking off a new swap
 *  cancels this download via the server-restart path.
 *
 *  The multi-download case collapses parallel ``(model_id, quantization)``
 *  downloads into one readable chip rather than letting them fight for the
 *  trigger's single-line slot. Each badge inside the popup keeps its own
 *  per-quant progress fill regardless. */
function DownloadingBody({
	ariaLabel,
	selectedModel,
	toModel,
	percent,
	count = 1,
	averagePercent = null,
	peers,
}: {
	ariaLabel: string | undefined;
	averagePercent?: number | null;
	count?: number;
	peers?: readonly ModelInfo[] | undefined;
	percent: number | null;
	selectedModel: ModelInfo | undefined;
	toModel: ModelInfo | undefined;
}) {
	const multi = count >= 2;
	const singleTargetLabel = toModel ? variantDisplayName(toModel, peers) : "model";
	const targetLabel = multi ? `${count} downloads` : singleTargetLabel;
	const reportedPercent = multi ? averagePercent : percent;
	const percentLabel = reportedPercent === null ? "Starting…" : `${reportedPercent}%`;
	return (
		<output
			aria-label={ariaLabel}
			aria-live="polite"
			className="flex min-w-0 flex-1 items-center gap-2"
			data-slot="downloading-body"
		>
			{selectedModel ? (
				<SelectedContent peers={peers} selectedModel={selectedModel} />
			) : (
				<span className="font-medium text-body text-foreground-muted italic tracking-tight">
					(no model)
				</span>
			)}
			<span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-surface-secondary/60 px-2 py-0.5 font-medium text-[10px] text-foreground-secondary leading-none">
				<PulseDot className="size-1.5 text-accent" />
				<span className="truncate">↓ {targetLabel}</span>
				<span className="font-mono text-foreground tabular-nums">{percentLabel}</span>
			</span>
		</output>
	);
}

function TriggerBody({
	isSwitching,
	isDownloadingTarget,
	isBackgroundDownload,
	downloadPercent,
	downloadCount,
	downloadAveragePercent,
	downloadingModel,
	fromModel,
	toModel,
	selectedModel,
	placeholder,
	ariaLabel,
	peers,
}: {
	ariaLabel: string | undefined;
	/** Catalog of known models — lets {@link variantDisplayName} keep the size
	 *  token when two would collide (Canary 180M Flash vs Canary 1B Flash). */
	peers?: readonly ModelInfo[] | undefined;
	/** Mean percent across all in-flight downloads — drives the percent
	 *  label when ``downloadCount >= 2``. */
	downloadAveragePercent: number | null;
	/** Total in-flight downloads (per-quant + legacy singleton). When 2+,
	 *  ``DownloadingBody`` switches to the aggregate "N downloads · X%"
	 *  view. */
	downloadCount: number;
	downloadPercent: number | null;
	/** Resolved ``ModelInfo`` for whatever model the active download is
	 *  fetching — may be the swap target or, in the per-quant streaming
	 *  case, the model the user clicked "Download" on from a badge. */
	downloadingModel: ModelInfo | undefined;
	fromModel: ModelInfo | undefined;
	/** Per-quant streaming download running while NO swap is active.
	 *  Renders the same ``DownloadingBody`` chrome the swap-target case
	 *  uses, so the trigger consistently surfaces in-flight bytes
	 *  regardless of whether they were kicked off by selection or by
	 *  the per-badge Download button. */
	isBackgroundDownload: boolean;
	isDownloadingTarget: boolean;
	isSwitching: boolean;
	placeholder: string;
	selectedModel: ModelInfo | undefined;
	toModel: ModelInfo | undefined;
}) {
	if (isSwitching && isDownloadingTarget) {
		return (
			<DownloadingBody
				ariaLabel={ariaLabel}
				averagePercent={downloadAveragePercent}
				count={downloadCount}
				peers={peers}
				percent={downloadPercent}
				selectedModel={selectedModel}
				toModel={toModel}
			/>
		);
	}
	if (isBackgroundDownload) {
		return (
			<DownloadingBody
				ariaLabel={ariaLabel}
				averagePercent={downloadAveragePercent}
				count={downloadCount}
				peers={peers}
				percent={downloadPercent}
				selectedModel={selectedModel}
				toModel={downloadingModel}
			/>
		);
	}
	if (isSwitching) {
		return (
			<SwitchingFromToRow
				ariaLabel={ariaLabel}
				from={fromModel ? <SttModelLabel model={fromModel} peers={peers} side="from" /> : undefined}
				to={toModel ? <SttModelLabel model={toModel} peers={peers} side="to" /> : undefined}
			/>
		);
	}
	if (selectedModel) {
		return <SelectedContent peers={peers} selectedModel={selectedModel} />;
	}
	return (
		<span className="font-medium text-body text-foreground-muted italic tracking-tight">
			{placeholder}
		</span>
	);
}

function resolveToModel(
	targetName: string | null,
	selectedModel: ModelInfo | undefined,
	catalog: readonly ModelInfo[]
): ModelInfo | undefined {
	if (!targetName) {
		return;
	}
	if (selectedModel && selectedModel.id === targetName) {
		return selectedModel;
	}
	return catalog.find((m) => m.id === targetName) ?? undefined;
}

interface AriaLabelInputs {
	downloadAveragePercent: number | null;
	downloadCount: number;
	downloadingModel: ModelInfo | undefined;
	downloadPercent: number | null;
	fromModel: ModelInfo | undefined;
	isBackgroundDownload: boolean;
	isDownloadingTarget: boolean;
	isMultiDownload: boolean;
	isSwitching: boolean;
	selectedModel: ModelInfo | undefined;
	toModel: ModelInfo | undefined;
}

/** Pulled out of {@link TriggerButton} so its body stays under Biome's
 *  cognitive-complexity cap. Returns the screen-reader caption that
 *  describes the trigger's current state — multi-download, single
 *  background download, swap+download, or plain swap. */
function buildAriaLabel(inputs: AriaLabelInputs): string | undefined {
	const loadedName = inputs.selectedModel?.displayName ?? "none";
	if (inputs.isMultiDownload && (inputs.isBackgroundDownload || inputs.isDownloadingTarget)) {
		const pct =
			inputs.downloadAveragePercent === null
				? "starting"
				: `${inputs.downloadAveragePercent} percent average`;
		return `Downloading ${inputs.downloadCount} models (${pct}). Currently loaded: ${loadedName}.`;
	}
	if (inputs.isBackgroundDownload && inputs.downloadingModel) {
		const pct = inputs.downloadPercent === null ? "starting" : `${inputs.downloadPercent} percent`;
		return `Downloading ${inputs.downloadingModel.displayName} (${pct}). Currently loaded: ${loadedName}.`;
	}
	if (!(inputs.isSwitching && inputs.toModel)) {
		return;
	}
	if (inputs.isDownloadingTarget) {
		const pct = inputs.downloadPercent === null ? "starting" : `${inputs.downloadPercent} percent`;
		return `Downloading ${inputs.toModel.displayName} (${pct}). Currently loaded: ${loadedName}.`;
	}
	const fromClause = inputs.fromModel ? ` from ${inputs.fromModel.displayName}` : "";
	return `Switching${fromClause} to ${inputs.toModel.displayName}`;
}

interface TriggerButtonProps extends SttModelSelectorTriggerProps {
	buttonProps: ComponentPropsWithoutRef<"button">;
}

// Glass-card trigger. Material vocabulary matches the pill: theme-token
// vertical gradient + hairline inset ring + tinted drop shadow + inset top
// highlight. The accent (Docker blue) appears only when open, as a 1px
// hairline at the top edge — the single saturated moment in the control.
//
// In-flight swap state: the card backdrop picks up a faint accent tint
// (`data-[switching=true]`), the chevron is swapped for a "SWITCHING" pill,
// the static `[author] name` row is replaced by a `from → ◌ → to` row, and
// an accent gradient sweeps across the bottom edge — together a continuous,
// readable transition view that lasts the full swap. All three pieces come
// from `@/shared/ui/switching-trigger` so the Ollama picker reads identically.
function TriggerButton({ buttonProps, ...rest }: TriggerButtonProps) {
	const { kind, catalog, selectedModel, downloadProgress } = rest;
	const swapTargetName = useModelSwapStore((s) =>
		kind === "main" ? s.activeMain : s.activeRealtime
	);
	const swapFromName = useModelSwapStore((s) => (kind === "main" ? s.fromMain : s.fromRealtime));
	const isSwitching = swapTargetName !== null;
	const fromModel = swapFromName
		? (catalog.find((m) => m.id === swapFromName) ?? undefined)
		: undefined;
	const toModel = resolveToModel(swapTargetName, selectedModel, catalog);
	// We're in the "downloading" sub-phase of the swap when a download is
	// active AND its model id matches the in-flight swap target. The UI
	// must read this from the caller-supplied download snapshot rather
	// than peeking at the store directly — the model-picker package is
	// self-contained (see package.json).
	const isDownloadingTarget =
		downloadProgress != null &&
		swapTargetName !== null &&
		downloadProgress.modelId === swapTargetName;
	// Per-quant streaming download running on its own (the user hit the
	// Download button on a badge, no swap was kicked off): surface the
	// same trigger chrome without claiming a swap is in flight.
	const isBackgroundDownload = !isSwitching && downloadProgress != null;
	const downloadingModel = downloadProgress
		? (catalog.find((m) => m.id === downloadProgress.modelId) ?? undefined)
		: undefined;
	const downloadPercent =
		isDownloadingTarget || isBackgroundDownload ? (downloadProgress?.percent ?? null) : null;
	const downloadCount = downloadProgress?.count ?? (downloadProgress ? 1 : 0);
	const downloadAveragePercent = downloadProgress?.averagePercent ?? null;
	const isMultiDownload = downloadCount >= 2;
	const ariaLabel = buildAriaLabel({
		downloadAveragePercent,
		downloadCount,
		downloadPercent,
		downloadingModel,
		fromModel,
		isBackgroundDownload,
		isDownloadingTarget,
		isMultiDownload,
		isSwitching,
		selectedModel,
		toModel,
	});
	// Treat a background per-quant download as "trigger-active" for the
	// visual treatments shared with swaps — the accent hairline, the
	// pill, the sweep bar — so the user gets the same "something is in
	// flight" affordance regardless of which pathway initiated the bytes.
	const isTriggerActive = isSwitching || isBackgroundDownload;
	const baseClass =
		"group relative flex h-auto min-h-[3.25rem] w-full items-center justify-between gap-2 overflow-hidden rounded-lg bg-gradient-to-b from-[var(--color-surface-3)]/85 to-[var(--color-surface-2)]/95 px-3 py-2 text-left shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_2px_6px_-3px_rgba(2,3,8,0.55)] ring-1 ring-white/[0.07] ring-inset transition-[transform,background-color,box-shadow] duration-150 ease-out hover:from-[var(--color-surface-4)]/85 hover:to-[var(--color-surface-3)]/95 hover:ring-white/[0.13] active:scale-[0.99] disabled:cursor-not-allowed data-[state=open]:from-[oklch(62%_0.19_260/0.10)] data-[state=open]:to-[var(--color-surface-2)]/95 data-[state=open]:ring-accent/40";
	return (
		<Button
			{...buttonProps}
			aria-expanded={rest.open}
			aria-label={ariaLabel}
			className={`${baseClass} ${buildSwitchingClassName(isTriggerActive)}`}
			data-slot="stt-model-selector-trigger"
			data-state={rest.open ? "open" : "closed"}
			data-switching={isTriggerActive}
			disabled={rest.disabled}
			type="button"
		>
			{/* Accent hairline — fades in when the popup is open, a swap is in
			    flight, OR a per-quant streaming download is running. Same
			    one-accent-moment vocabulary across all three states. */}
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent opacity-0 transition-opacity duration-200 group-data-[state=open]:opacity-100 group-data-[switching=true]:opacity-100"
			/>
			<TriggerBody
				ariaLabel={ariaLabel}
				downloadAveragePercent={downloadAveragePercent}
				downloadCount={downloadCount}
				downloadingModel={downloadingModel}
				downloadPercent={downloadPercent}
				fromModel={fromModel}
				isBackgroundDownload={isBackgroundDownload}
				isDownloadingTarget={isDownloadingTarget}
				isSwitching={isSwitching}
				peers={catalog}
				placeholder={rest.placeholder}
				selectedModel={rest.selectedModel}
				toModel={toModel}
			/>
			{isTriggerActive ? (
				<SwitchingPill
					label={isDownloadingTarget || isBackgroundDownload ? "Downloading" : "Switching"}
				/>
			) : (
				<HugeiconsIcon
					className="ms-2 size-4 shrink-0 text-foreground-muted transition-[transform,color] duration-200 ease-out group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground"
					icon={ArrowDown01Icon}
				/>
			)}
			{isTriggerActive ? <SwapSweepBar /> : null}
		</Button>
	);
}

export function SttModelSelectorTrigger(props: SttModelSelectorTriggerProps) {
	return (
		<Combobox.Trigger
			nativeButton
			render={(p) => (
				<TriggerButton {...props} buttonProps={p as ComponentPropsWithoutRef<"button">} />
			)}
		/>
	);
}

/** Standalone trigger button — same glass-card visual, swap/download states,
 *  and ``data-slot`` as {@link SttModelSelectorTrigger}, but WITHOUT the
 *  ``Combobox.Trigger`` wrapper. For consumers that open the detached picker
 *  BrowserWindow on click (extending beyond the host window) instead of an
 *  in-window popup — the settings panel and the footer chip share this path. */
export function SttModelSelectorTriggerButton({
	onActivate,
	...props
}: SttModelSelectorTriggerProps & {
	onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
	return <TriggerButton {...props} buttonProps={{ type: "button", onClick: onActivate }} />;
}

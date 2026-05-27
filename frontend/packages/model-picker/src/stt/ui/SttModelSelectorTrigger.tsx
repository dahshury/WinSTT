"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { type ModelInfo, useModelSwapStore } from "@/entities/model-catalog";
import { Button } from "@/shared/ui/button";
import {
	buildSwitchingClassName,
	SwapSweepBar,
	SwitchingFromToRow,
	SwitchingPill,
} from "@/shared/ui/switching-trigger";
import { getAuthorLabel, getFamilyConfig } from "../lib/family-helpers";

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
	 *  The model-picker package is self-contained (no `@/shared/*` imports
	 *  by design — see `package.json`); the consumer is responsible for
	 *  wiring the store. `percent` is `null` when the first progress event
	 *  hasn't landed yet (indeterminate start). */
	downloadProgress?: { modelId: string; percent: number | null } | null;
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
					className={`size-3 rounded-[2px] object-cover ${muted ? "opacity-60" : ""}`}
					height={12}
					src={config.logoSrc}
					width={12}
				/>
			) : (
				<HugeiconsIcon className="size-3" icon={config.icon} />
			)}
			{author}
		</span>
	);
}

/** "NeMo Parakeet CTC 0.6B" → "Parakeet CTC 0.6B" — the author chip on the
 *  left already conveys the family, so leading it in the name is redundant. */
function stripFamilyPrefix(model: ModelInfo): string {
	const familyLabel = getFamilyConfig(model.family).label;
	const stripped = model.displayName.replace(new RegExp(`^${familyLabel}\\s+`), "");
	return stripped.length > 0 ? stripped : model.displayName;
}

function SelectedContent({ selectedModel }: { selectedModel: ModelInfo }) {
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<AuthorChip family={selectedModel.family} />
			<span className="truncate font-medium text-body text-foreground leading-tight tracking-tight">
				{stripFamilyPrefix(selectedModel)}
			</span>
		</div>
	);
}

/** STT-flavored chip+name pair used as a slot inside `SwitchingFromToRow`. */
function SttModelLabel({ model, side }: { model: ModelInfo; side: "from" | "to" }) {
	if (side === "from") {
		return (
			<>
				<AuthorChip family={model.family} muted />
				<span className="min-w-0 max-w-[8rem] truncate font-medium text-body text-foreground-dim leading-tight tracking-tight line-through decoration-foreground-dim/40">
					{stripFamilyPrefix(model)}
				</span>
			</>
		);
	}
	return (
		<>
			<AuthorChip family={model.family} />
			<span className="min-w-0 truncate font-semibold text-accent text-body leading-tight tracking-tight">
				{stripFamilyPrefix(model)}
			</span>
		</>
	);
}

/** Downloading body — shows the selected (still-active) model on the left
 *  and "Downloading <target> · 23%" on the right. Distinct from the
 *  `[from → ◌ → to]` switching view because here the picker is NOT in a
 *  swap window: bytes are still flowing into the HF cache and the server
 *  hasn't restarted yet. The user can still pick another already-cached
 *  model from the popup — kicking off a new swap cancels this download
 *  via the server-restart path. */
function DownloadingBody({
	ariaLabel,
	selectedModel,
	toModel,
	percent,
}: {
	ariaLabel: string | undefined;
	percent: number | null;
	selectedModel: ModelInfo | undefined;
	toModel: ModelInfo | undefined;
}) {
	const targetLabel = toModel ? stripFamilyPrefix(toModel) : "model";
	const percentLabel = percent === null ? "Starting…" : `${percent}%`;
	return (
		<output
			aria-label={ariaLabel}
			aria-live="polite"
			className="flex min-w-0 flex-1 items-center gap-2"
			data-slot="downloading-body"
		>
			{selectedModel ? (
				<SelectedContent selectedModel={selectedModel} />
			) : (
				<span className="font-medium text-body text-foreground-muted italic tracking-tight">
					(no model)
				</span>
			)}
			<span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-surface-secondary/60 px-2 py-0.5 font-medium text-[10px] text-foreground-secondary leading-none">
				<span className="size-1.5 animate-pulse rounded-full bg-accent" />
				<span className="truncate">↓ {targetLabel}</span>
				<span className="font-mono text-foreground tabular-nums">{percentLabel}</span>
			</span>
		</output>
	);
}

function TriggerBody({
	isSwitching,
	isDownloadingTarget,
	downloadPercent,
	fromModel,
	toModel,
	selectedModel,
	placeholder,
	ariaLabel,
}: {
	ariaLabel: string | undefined;
	downloadPercent: number | null;
	fromModel: ModelInfo | undefined;
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
				percent={downloadPercent}
				selectedModel={selectedModel}
				toModel={toModel}
			/>
		);
	}
	if (isSwitching) {
		return (
			<SwitchingFromToRow
				ariaLabel={ariaLabel}
				from={fromModel ? <SttModelLabel model={fromModel} side="from" /> : undefined}
				to={toModel ? <SttModelLabel model={toModel} side="to" /> : undefined}
			/>
		);
	}
	if (selectedModel) {
		return <SelectedContent selectedModel={selectedModel} />;
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
	const downloadPercent = isDownloadingTarget ? (downloadProgress?.percent ?? null) : null;
	const ariaLabel = (() => {
		if (!(isSwitching && toModel)) {
			return;
		}
		if (isDownloadingTarget) {
			const pct = downloadPercent === null ? "starting" : `${downloadPercent} percent`;
			return `Downloading ${toModel.displayName} (${pct}). Currently loaded: ${selectedModel?.displayName ?? "none"}.`;
		}
		return `Switching${fromModel ? ` from ${fromModel.displayName}` : ""} to ${toModel.displayName}`;
	})();
	const baseClass =
		"group relative flex h-auto min-h-[3.25rem] w-full items-center justify-between gap-2 overflow-hidden rounded-lg bg-gradient-to-b from-[var(--color-surface-3)]/85 to-[var(--color-surface-2)]/95 px-3 py-2 text-left shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_2px_6px_-3px_rgba(2,3,8,0.55)] ring-1 ring-white/[0.07] ring-inset transition-[transform,background-color,box-shadow] duration-150 ease-out hover:from-[var(--color-surface-4)]/85 hover:to-[var(--color-surface-3)]/95 hover:ring-white/[0.13] active:scale-[0.99] disabled:cursor-not-allowed data-[state=open]:from-[oklch(62%_0.19_260/0.10)] data-[state=open]:to-[var(--color-surface-2)]/95 data-[state=open]:ring-accent/40";
	return (
		<Button
			{...buttonProps}
			aria-expanded={rest.open}
			aria-label={ariaLabel}
			className={`${baseClass} ${buildSwitchingClassName(isSwitching)}`}
			data-slot="stt-model-selector-trigger"
			data-state={rest.open ? "open" : "closed"}
			data-switching={isSwitching}
			disabled={rest.disabled}
			type="button"
		>
			{/* Accent hairline — fades in when the popup is open OR a swap is in
			    flight. Same one-accent-moment vocabulary in both states. */}
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent opacity-0 transition-opacity duration-200 group-data-[state=open]:opacity-100 group-data-[switching=true]:opacity-100"
			/>
			<TriggerBody
				ariaLabel={ariaLabel}
				downloadPercent={downloadPercent}
				fromModel={fromModel}
				isDownloadingTarget={isDownloadingTarget}
				isSwitching={isSwitching}
				placeholder={rest.placeholder}
				selectedModel={rest.selectedModel}
				toModel={toModel}
			/>
			{isSwitching ? (
				<SwitchingPill label={isDownloadingTarget ? "Downloading" : "Switching"} />
			) : (
				<HugeiconsIcon
					className="ms-2 size-4 shrink-0 text-foreground-muted transition-[transform,color] duration-200 ease-out group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground"
					icon={ArrowDown01Icon}
				/>
			)}
			{isSwitching ? <SwapSweepBar /> : null}
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

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
				// biome-ignore lint/performance/noImgElement: static local maker logo
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

function renderTriggerBody({
	isSwitching,
	fromModel,
	toModel,
	selectedModel,
	placeholder,
	ariaLabel,
}: {
	ariaLabel: string | undefined;
	fromModel: ModelInfo | undefined;
	isSwitching: boolean;
	placeholder: string;
	selectedModel: ModelInfo | undefined;
	toModel: ModelInfo | undefined;
}) {
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
	const { kind, catalog, selectedModel } = rest;
	const swapTargetName = useModelSwapStore((s) =>
		kind === "main" ? s.activeMain : s.activeRealtime
	);
	const swapFromName = useModelSwapStore((s) => (kind === "main" ? s.fromMain : s.fromRealtime));
	const isSwitching = swapTargetName !== null;
	const fromModel = swapFromName
		? (catalog.find((m) => m.id === swapFromName) ?? undefined)
		: undefined;
	const toModel = resolveToModel(swapTargetName, selectedModel, catalog);
	const ariaLabel =
		isSwitching && toModel
			? `Switching${fromModel ? ` from ${fromModel.displayName}` : ""} to ${toModel.displayName}`
			: undefined;
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
			{renderTriggerBody({
				isSwitching,
				fromModel,
				toModel,
				selectedModel: rest.selectedModel,
				placeholder: rest.placeholder,
				ariaLabel,
			})}
			{isSwitching ? (
				<SwitchingPill />
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

"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { Button } from "@/shared/ui/button";
import { getCachePillConfig, resolveQuantCache } from "../lib/cache-helpers";
import { getFamilyConfig } from "../lib/family-helpers";
import { supportsQuantization } from "../lib/quantization-helpers";

export interface SttModelSelectorTriggerProps {
	currentQuantization: OnnxQuantization;
	disabled: boolean;
	open: boolean;
	placeholder: string;
	selectedModel: ModelInfo | undefined;
	state: ModelStateEntry | undefined;
}

function FamilyBadge({ family }: { family: ModelInfo["family"] }) {
	const config = getFamilyConfig(family);
	return (
		<span
			className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-[10px] leading-none tracking-tight ${config.chip}`}
		>
			<HugeiconsIcon className="size-3" icon={config.icon} />
			{config.label}
		</span>
	);
}

function CacheBadge({
	state,
	quantization,
}: {
	quantization: OnnxQuantization;
	state: ModelStateEntry | undefined;
}) {
	const config = getCachePillConfig(resolveQuantCache(state, quantization));
	if (!config) {
		return null;
	}
	return (
		<span
			className={`inline-flex shrink-0 items-center gap-1 rounded-[4px] border px-1.5 py-0.5 font-medium text-[10px] leading-none ${config.className}`}
		>
			<HugeiconsIcon className="size-3" icon={config.icon} />
			{config.label}
		</span>
	);
}

function QuantizationBadge({
	quantization,
	visible,
}: {
	quantization: OnnxQuantization;
	visible: boolean;
}) {
	if (!visible) {
		return null;
	}
	const label = quantization === "" ? "Auto" : quantization;
	return (
		<span className="inline-flex shrink-0 items-center rounded-[4px] border border-border/60 bg-surface-2/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground-secondary leading-none tracking-tight">
			{label}
		</span>
	);
}

function MetaLine({
	selectedModel,
	state,
	currentQuantization,
}: {
	currentQuantization: OnnxQuantization;
	selectedModel: ModelInfo;
	state: ModelStateEntry | undefined;
}) {
	const showQuant = supportsQuantization(selectedModel);
	return (
		<div className="flex items-center gap-1.5">
			<span className="font-mono text-[10px] text-foreground-muted uppercase leading-none tracking-[0.06em]">
				{selectedModel.sizeLabel}
			</span>
			<span aria-hidden="true" className="text-[10px] text-foreground-dim leading-none">
				·
			</span>
			<CacheBadge quantization={currentQuantization} state={state} />
			<QuantizationBadge quantization={currentQuantization} visible={showQuant} />
		</div>
	);
}

function SelectedContent({
	selectedModel,
	state,
	currentQuantization,
}: {
	currentQuantization: OnnxQuantization;
	selectedModel: ModelInfo;
	state: ModelStateEntry | undefined;
}) {
	return (
		<div className="flex min-w-0 flex-1 items-center gap-3">
			<FamilyBadge family={selectedModel.family} />
			<div className="flex min-w-0 flex-1 flex-col items-start gap-1">
				<span className="w-full truncate font-medium text-body text-foreground leading-tight tracking-tight">
					{selectedModel.displayName}
				</span>
				<MetaLine
					currentQuantization={currentQuantization}
					selectedModel={selectedModel}
					state={state}
				/>
			</div>
		</div>
	);
}

function renderContent(props: SttModelSelectorTriggerProps) {
	if (props.selectedModel) {
		return (
			<SelectedContent
				currentQuantization={props.currentQuantization}
				selectedModel={props.selectedModel}
				state={props.state}
			/>
		);
	}
	return (
		<span className="font-medium text-body text-foreground-muted italic tracking-tight">
			{props.placeholder}
		</span>
	);
}

interface TriggerButtonProps extends SttModelSelectorTriggerProps {
	buttonProps: ComponentPropsWithoutRef<"button">;
}

// Glass-card trigger. Material vocabulary matches the pill: theme-token
// vertical gradient + hairline inset ring + tinted drop shadow + inset top
// highlight. The accent (Docker blue) appears only when open, as a 1px
// hairline at the top edge — the single saturated moment in the control.
function TriggerButton({ buttonProps, ...rest }: TriggerButtonProps) {
	return (
		<Button
			{...buttonProps}
			aria-expanded={rest.open}
			className="group relative flex h-auto min-h-[3.25rem] w-full items-center justify-between gap-2 overflow-hidden rounded-lg bg-gradient-to-b from-[var(--color-surface-3)]/85 to-[var(--color-surface-2)]/95 px-3 py-2 text-left shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_2px_6px_-3px_rgba(2,3,8,0.55)] ring-1 ring-white/[0.07] ring-inset transition-[transform,background-color,box-shadow] duration-150 ease-out hover:from-[var(--color-surface-4)]/85 hover:to-[var(--color-surface-3)]/95 hover:ring-white/[0.13] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:from-[oklch(62%_0.19_260/0.10)] data-[state=open]:to-[var(--color-surface-2)]/95 data-[state=open]:ring-accent/40"
			data-slot="stt-model-selector-trigger"
			data-state={rest.open ? "open" : "closed"}
			disabled={rest.disabled}
			type="button"
		>
			{/* Accent hairline — fades in only when the popup is open. The
			    pill uses the same hairline for the same reason: one accent
			    moment that marks state. */}
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent opacity-0 transition-opacity duration-200 group-data-[state=open]:opacity-100"
			/>
			{renderContent(rest)}
			<HugeiconsIcon
				className="ms-2 size-4 shrink-0 text-foreground-muted transition-[transform,color] duration-200 ease-out group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground"
				icon={ArrowDown01Icon}
			/>
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

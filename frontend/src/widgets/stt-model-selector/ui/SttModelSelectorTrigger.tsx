"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowUpDownIcon } from "@hugeicons/core-free-icons";
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
			className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-[10px] leading-none ${config.chip}`}
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
			className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium text-[10px] leading-none ${config.className}`}
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
		<span className="inline-flex shrink-0 items-center rounded-md border border-border bg-surface-secondary/60 px-1.5 py-0.5 font-medium text-[10px] text-foreground-secondary leading-none">
			{label}
		</span>
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
		<div className="flex min-w-0 flex-1 flex-col items-start gap-1">
			<div className="flex w-full min-w-0 items-center gap-2">
				<FamilyBadge family={selectedModel.family} />
				<span className="truncate font-medium text-foreground">{selectedModel.displayName}</span>
				<span className="shrink-0 text-foreground-muted text-xs">{selectedModel.sizeLabel}</span>
			</div>
			<div className="flex items-center gap-1.5">
				<CacheBadge quantization={currentQuantization} state={state} />
				<QuantizationBadge
					quantization={currentQuantization}
					visible={supportsQuantization(selectedModel)}
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
	return <span className="text-foreground-muted">{props.placeholder}</span>;
}

interface TriggerButtonProps extends SttModelSelectorTriggerProps {
	buttonProps: ComponentPropsWithoutRef<"button">;
}

function TriggerButton({ buttonProps, ...rest }: TriggerButtonProps) {
	return (
		<Button
			{...buttonProps}
			aria-expanded={rest.open}
			className="flex h-auto min-h-10 w-full items-center justify-between rounded-sm border border-border bg-surface-secondary px-3 py-2 text-left hover:bg-surface-hover"
			data-slot="stt-model-selector-trigger"
			data-state={rest.open ? "open" : "closed"}
			disabled={rest.disabled}
			type="button"
		>
			{renderContent(rest)}
			<HugeiconsIcon
				className="ms-2 size-4 shrink-0 text-foreground-muted"
				icon={ArrowUpDownIcon}
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

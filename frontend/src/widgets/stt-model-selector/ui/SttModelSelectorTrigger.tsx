"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowUpDownIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ModelInfo } from "@/entities/model-catalog";
import { useDownloadStore } from "@/features/model-download";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { cn } from "@/shared/lib/cn";
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

function TriggerContent(props: SttModelSelectorTriggerProps) {
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

/**
 * Thin progress strip + "↓ Model · NN%" caption pinned to the trigger's
 * bottom edge while a download is in flight. Lets the user track a long
 * pull (whisper-large-v3 is ~3 GB) without keeping the picker open.
 * ``pointer-events-none`` so clicks still reach the underlying button.
 */
function TriggerPullProgressOverlay({
	displayName,
	percent,
}: {
	displayName: string;
	percent: number | null;
}) {
	const width = percent ?? 0;
	const indeterminate = percent === null;
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-3 pb-1 text-[9px] text-accent leading-none"
		>
			<span className="truncate font-medium uppercase tracking-wide">
				↓ {displayName} · {indeterminate ? "…" : `${percent}%`}
			</span>
			<span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-accent/20">
				<span
					className={cn(
						"block h-full bg-accent transition-[width] duration-300 ease-out",
						indeterminate && "animate-pulse"
					)}
					style={{ width: `${width}%` }}
				/>
			</span>
		</span>
	);
}

function TriggerButton({ buttonProps, ...rest }: TriggerButtonProps) {
	const pull = useDownloadStore(
		useShallow((s) => ({
			isDownloading: s.isDownloading,
			modelName: s.modelName,
			progress: s.progress,
		}))
	);
	// Prefer the catalog's display name when the in-flight model id matches
	// the currently-selected model — that's the common case. For a non-
	// selected model (rare: download was kicked off via the picker and the
	// user since picked a different model), fall back to the raw id.
	const activeName =
		pull.modelName && rest.selectedModel?.id === pull.modelName
			? rest.selectedModel.displayName
			: (pull.modelName ?? "");
	return (
		<Button
			{...buttonProps}
			aria-expanded={rest.open}
			className="relative flex h-auto min-h-10 w-full items-center justify-between overflow-hidden rounded-sm border border-border bg-surface-secondary px-3 py-2 text-left hover:bg-surface-hover"
			data-slot="stt-model-selector-trigger"
			data-state={rest.open ? "open" : "closed"}
			disabled={rest.disabled}
			type="button"
		>
			<TriggerContent {...rest} />
			<HugeiconsIcon
				className="ms-2 size-4 shrink-0 text-foreground-muted"
				icon={ArrowUpDownIcon}
			/>
			{pull.isDownloading && pull.modelName ? (
				<TriggerPullProgressOverlay displayName={activeName} percent={pull.progress} />
			) : null}
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

"use client";

import { Combobox } from "@base-ui/react/combobox";
import {
	ArrowDown01Icon,
	BinaryCodeIcon,
	Brain01Icon,
	CodeIcon,
	GpuIcon,
	Image01Icon,
	Mic01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";
import type { OllamaModel } from "@/shared/api/models";
import { Button } from "@/shared/ui/button";
import { PulseDot } from "@/shared/ui/pulse-dot";
import {
	buildSwitchingClassName,
	MODEL_TRIGGER_GLASS_CLASSES,
	SwapSweepBar,
	SwitchingFromToRow,
	SwitchingPill,
} from "@/shared/ui/switching-trigger";
import {
	SelectedModelSummary,
	type SelectedModelMetaItem,
} from "../../ui/SelectedModelSummary";
import {
	formatOllamaDisplayNameParts,
	formatOllamaDisplayName,
	formatOllamaSize,
	getOllamaFamily,
} from "../lib/family-helpers";
import {
	normalizedCapabilitySet,
	supportsOllamaToolCalling,
	visibleCapabilities,
} from "../lib/ollama-description-helpers";
import { PublisherChip } from "./OllamaModelChips";
import type {
	OllamaFitInfo,
	TriggerPullSummary,
} from "./ollama-selector-types";

// ── Trigger ───────────────────────────────────────────────────────────

function normalizeOllamaMetaToken(
	value: string | null | undefined,
): string | null {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

function resolveOllamaMemoryBytes(
	model: OllamaModel,
	getFit: ((sizeBytes: number) => OllamaFitInfo) | undefined,
): { bytes: number | null; description: string } {
	const modelSize =
		typeof model.size === "number" && model.size > 0 ? model.size : null;
	if (modelSize === null) {
		return {
			bytes: null,
			description:
				"Ollama did not report enough local size data to estimate VRAM usage.",
		};
	}
	const fit = getFit?.(modelSize);
	if (fit && fit.requiredBytes > 0) {
		return {
			bytes: fit.requiredBytes,
			description:
				"Estimated runtime VRAM usage, including Ollama's loading headroom.",
		};
	}
	return {
		bytes: modelSize,
		description:
			"Estimated from the installed model size because live fit data is unavailable.",
	};
}

function ollamaCapabilityIcon(label: string): IconSvgElement {
	switch (label.toLowerCase()) {
		case "vision":
			return Image01Icon;
		case "audio":
			return Mic01Icon;
		case "fill-in-middle":
			return CodeIcon;
		default:
			return BinaryCodeIcon;
	}
}

/** Alternate the capability glyphs between the two cool accents so a row of
 *  them reads as distinct facts rather than one flat block. */
function ollamaCapabilityTone(label: string): "accent" | "teal" {
	switch (label.toLowerCase()) {
		case "audio":
		case "fill-in-middle":
			return "teal";
		default:
			return "accent";
	}
}

/** Icon-only capability segments (tools / reasoning / vision / audio / …) folded
 *  into the same connected spec badge as the quant + memory facts, so they read
 *  as one badge at a uniform height instead of a separate, smaller chip cluster. */
function ollamaCapabilityMeta(
	rawCapabilities: readonly string[] | null | undefined,
): SelectedModelMetaItem[] {
	const capabilities = rawCapabilities ?? undefined;
	const items: SelectedModelMetaItem[] = [];
	if (supportsOllamaToolCalling(capabilities)) {
		items.push({
			key: "cap-tools",
			label: "",
			icon: Wrench01Icon,
			tone: "accent",
			title: "Tools",
			description: "Supports function / tool calling.",
		});
	}
	if (normalizedCapabilitySet(capabilities).has("thinking")) {
		items.push({
			key: "cap-thinking",
			label: "",
			icon: Brain01Icon,
			tone: "teal",
			title: "Reasoning",
			description: "Supports step-by-step reasoning.",
		});
	}
	for (const label of visibleCapabilities(capabilities, {
		excludeTools: true,
	})) {
		if (label.toLowerCase() === "thinking") {
			continue;
		}
		items.push({
			key: `cap-${label}`,
			label: "",
			icon: ollamaCapabilityIcon(label),
			tone: ollamaCapabilityTone(label),
			title: label.charAt(0).toUpperCase() + label.slice(1),
			description: "Model capability.",
		});
	}
	return items;
}

function selectedOllamaMeta(
	model: OllamaModel,
	getFit: ((sizeBytes: number) => OllamaFitInfo) | undefined,
): SelectedModelMetaItem[] {
	const parts = formatOllamaDisplayNameParts(model.name);
	const quantization = normalizeOllamaMetaToken(
		model.details?.quantizationLevel ?? parts.quantization,
	);
	const memory = resolveOllamaMemoryBytes(model, getFit);
	const memoryLabel =
		memory.bytes === null ? null : formatOllamaSize(memory.bytes);
	const items: SelectedModelMetaItem[] = [];
	if (quantization) {
		items.push({
			key: "quant",
			label: quantization,
			icon: BinaryCodeIcon,
			tone: "warning",
			title: "Quantization",
			description: `Selected Ollama quantization: ${quantization}.`,
		});
	}
	if (memoryLabel && memoryLabel !== "—") {
		items.push({
			key: "memory",
			label: memoryLabel,
			icon: GpuIcon,
			tone: "success",
			title: "Estimated VRAM usage",
			description: memory.description,
		});
	}
	items.push(...ollamaCapabilityMeta(model.capabilities));
	return items;
}

function SelectedTriggerContent({
	model,
	getFit,
}: {
	getFit: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	model: OllamaModel;
}) {
	const family = getOllamaFamily(model);
	const parts = formatOllamaDisplayNameParts(model.name);
	return (
		<SelectedModelSummary
			leading={<PublisherChip family={family} />}
			meta={selectedOllamaMeta(model, getFit)}
			metaPlacement="right"
			name={parts}
		/>
	);
}

// Match the STT/OpenRouter selector shell: theme-token vertical gradient,
// inset hairline ring, tinted depth shadow, and a restrained accent ring only
// while open or switching. Keeping the material identical prevents the
// Processing tab picker from blending into the settings background.
const OLLAMA_TRIGGER_GLASS_CLASSES = `${MODEL_TRIGGER_GLASS_CLASSES} disabled:opacity-50`;

/** Ollama-flavored chip+name pair used as a slot inside `SwitchingFromToRow`.
 *  Mirrors the STT picker's `SttModelLabel` so both switching views read the
 *  same way: family chip + name, dim/struck-through on the "from" leg and
 *  accent-emphasized on the "to" leg. */
function OllamaModelLabel({
	model,
	side,
}: {
	model: OllamaModel;
	side: "from" | "to";
}) {
	const family = getOllamaFamily(model);
	const displayName = formatOllamaDisplayName(model.name);
	if (side === "from") {
		return (
			<>
				<PublisherChip family={family} />
				<span className="min-w-0 max-w-[8rem] truncate font-medium text-body text-foreground-dim leading-tight tracking-tight line-through decoration-foreground-dim/40">
					{displayName}
				</span>
			</>
		);
	}
	return (
		<>
			<PublisherChip family={family} />
			<span className="min-w-0 truncate font-semibold text-accent text-body leading-tight tracking-tight">
				{displayName}
			</span>
		</>
	);
}

/** Fallback label when the user picked a model that isn't (yet) in the
 *  installed catalog — happens when the swap is "to" an Ollama-library hit
 *  that's still pulling. We can't render a publisher chip without the model
 *  metadata, so just render the bare display name with the same emphasis. */
function OllamaTextLabel({
	name,
	side,
}: {
	name: string;
	side: "from" | "to";
}) {
	const displayName = formatOllamaDisplayName(name);
	const tone =
		side === "from"
			? "text-foreground-dim line-through decoration-foreground-dim/40"
			: "font-semibold text-accent";
	return (
		<span
			className={`min-w-0 max-w-[8rem] truncate font-medium text-body leading-tight tracking-tight ${tone}`}
		>
			{displayName}
		</span>
	);
}

interface OllamaTriggerProps {
	activePull: TriggerPullSummary | null;
	disabled: boolean;
	fromModel: OllamaModel | undefined;
	fromName: string | undefined;
	getFit?: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	isLoading: boolean;
	isSwitching: boolean;
	placeholder: string;
	selected: OllamaModel | undefined;
	toModel: OllamaModel | undefined;
	toName: string | undefined;
}

type TriggerButtonElementProps = ComponentPropsWithoutRef<"button"> & {
	"data-state"?: "closed" | "open";
};

/** Pick the right label component for one side of the switching row. Prefers
 *  the resolved `OllamaModel` (publisher chip + name); falls back to the bare
 *  text label when the picked model isn't installed yet (typed pull target). */
function SwitchingSlot({
	model,
	name,
	side,
}: {
	model: OllamaModel | undefined;
	name: string | undefined;
	side: "from" | "to";
}): ReactNode {
	if (model) {
		return <OllamaModelLabel model={model} side={side} />;
	}
	if (name) {
		return <OllamaTextLabel name={name} side={side} />;
	}
	return null;
}

function OllamaBody({
	props,
	ariaLabel,
}: {
	props: OllamaTriggerProps;
	ariaLabel: string | undefined;
}): ReactNode {
	if (props.isSwitching) {
		return (
			<SwitchingFromToRow
				ariaLabel={ariaLabel}
				from={
					<SwitchingSlot
						model={props.fromModel}
						name={props.fromName}
						side="from"
					/>
				}
				to={
					<SwitchingSlot model={props.toModel} name={props.toName} side="to" />
				}
			/>
		);
	}
	// A selection wins over the loading state: opening the picker fires a
	// background `/api/tags` re-scan that flips `isLoading` true, and blanking
	// the already-known model's chip + name + badges on every open reads as the
	// trigger "losing" its content. Keep showing the selection; the scan is
	// silent. The loading placeholder only surfaces when nothing is picked yet.
	if (props.selected) {
		return (
			<SelectedTriggerContent getFit={props.getFit} model={props.selected} />
		);
	}
	if (props.isLoading) {
		return (
			<div className="flex flex-1 items-center gap-2">
				<PulseDot className="size-2.5 text-foreground-muted" />
				<span className="font-medium text-body text-foreground-muted italic tracking-tight">
					{props.placeholder}
				</span>
			</div>
		);
	}
	return (
		<span className="font-medium text-body text-foreground-muted italic tracking-tight">
			{props.placeholder}
		</span>
	);
}

function buildSwitchingAriaLabel(
	props: OllamaTriggerProps,
): string | undefined {
	if (!props.isSwitching) {
		return;
	}
	const toName = props.toModel?.name ?? props.toName;
	if (!toName) {
		return;
	}
	const fromName = props.fromModel?.name ?? props.fromName;
	const fromClause = fromName
		? ` from ${formatOllamaDisplayName(fromName)}`
		: "";
	return `Switching${fromClause} to ${formatOllamaDisplayName(toName)}`;
}

function OllamaTriggerButtonView({
	buttonProps,
	props,
}: {
	buttonProps: TriggerButtonElementProps;
	props: OllamaTriggerProps;
}) {
	const { disabled, isLoading, isSwitching, activePull } = props;
	const ariaLabel = buildSwitchingAriaLabel(props);
	// `isLoading` is a SOFT background state (the open-triggered `/api/tags`
	// re-scan), not a hard disable. Once a model is selected it must not dim or
	// block the trigger — doing so flashed the picked model to 50% opacity on
	// every open. It only stands in for "nothing to interact with yet" while
	// there is no selection (the first scan, showing the "Scanning…" pill).
	const loadingBlocksInteraction = isLoading && !props.selected;
	return (
		<Button
			{...buttonProps}
			aria-label={ariaLabel}
			className={`${OLLAMA_TRIGGER_GLASS_CLASSES} ${buildSwitchingClassName(isSwitching)}`}
			data-loading={isLoading || undefined}
			data-slot="ollama-model-selector-trigger"
			data-switching={isSwitching}
			disabled={disabled || loadingBlocksInteraction || isSwitching}
			type="button"
		>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent opacity-0 transition-opacity duration-200 group-data-[state=open]:opacity-100 group-data-[switching=true]:opacity-100"
			/>
			<OllamaBody ariaLabel={ariaLabel} props={props} />
			{isSwitching ? (
				<SwitchingPill />
			) : (
				<HugeiconsIcon
					className="ms-2 size-4 shrink-0 text-foreground-muted transition-[transform,color] duration-200 ease-out group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground"
					icon={ArrowDown01Icon}
				/>
			)}
			{isSwitching ? <SwapSweepBar /> : null}
			{activePull && !isSwitching ? (
				<TriggerPullProgressOverlay summary={activePull} />
			) : null}
		</Button>
	);
}

export function OllamaTrigger(props: OllamaTriggerProps) {
	return (
		<Combobox.Trigger
			nativeButton
			render={(triggerProps) => (
				<OllamaTriggerButtonView
					buttonProps={triggerProps as TriggerButtonElementProps}
					props={props}
				/>
			)}
		/>
	);
}

export function OllamaTriggerButton({
	onActivate,
	...props
}: OllamaTriggerProps & {
	onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
	return (
		<OllamaTriggerButtonView
			buttonProps={{
				"aria-expanded": false,
				"data-state": "closed",
				onClick: onActivate,
				type: "button",
			}}
			props={props}
		/>
	);
}

/** Thin status overlay rendered along the trigger's bottom edge whenever an
 *  Ollama pull is in flight. Conveys two things at a glance while the popup
 *  is closed:
 *
 *    1. A 2px progress strip that fills left → right as bytes land.
 *    2. A label `Downloading <model> · NN%` so the user knows *which* model
 *       is in flight (multiple feature toggles can share the same picker).
 */
function TriggerPullProgressOverlay({
	summary,
}: {
	summary: TriggerPullSummary;
}) {
	const beautified = formatOllamaDisplayName(summary.model);
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-3 pb-1 text-[9px] text-accent leading-none"
		>
			<span className="truncate font-medium uppercase tracking-wide">
				↓ {beautified} · {summary.percent}%
			</span>
			<span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-accent/20">
				<span
					className="block h-full bg-accent transition-[width] duration-300 ease-out"
					style={{ width: `${summary.percent}%` }}
				/>
			</span>
		</span>
	);
}

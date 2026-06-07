"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { OllamaModel, OllamaPullProgress } from "@/shared/api/models";
import { Button } from "@/shared/ui/button";
import { PulseDot } from "@/shared/ui/pulse-dot";
import {
	buildSwitchingClassName,
	SwapSweepBar,
	SwitchingFromToRow,
	SwitchingPill,
} from "@/shared/ui/switching-trigger";
import { TruncatedText } from "../../ui/TruncatedText";
import {
	formatOllamaDisplayName,
	getOllamaFamily,
} from "../lib/family-helpers";
import { OllamaToolCapabilityBadge, PublisherChip } from "./OllamaModelChips";
import type { TriggerPullSummary } from "./ollama-selector-types";

// ── Trigger ───────────────────────────────────────────────────────────

function SelectedTriggerContent({ model }: { model: OllamaModel }) {
	const family = getOllamaFamily(model);
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<PublisherChip family={family} />
			<TruncatedText
				className="flex-1 font-medium text-foreground"
				text={formatOllamaDisplayName(model.name)}
			/>
			<OllamaToolCapabilityBadge
				capabilities={model.capabilities}
				className="shrink-0"
			/>
		</div>
	);
}

// Flat muted surface — calmed off the old "glass" (white inset highlight +
// white ring + bright hover ring). The trigger now reads as a flat surface step
// (surface-3 over the popup) with a neutral hairline border + soft depth shadow,
// matching the fluidfunctionalism grayscale base. The single accent moments are
// restrained and state-only: the open-state accent ring + the accent hairline
// (rendered in the JSX) + the accent pull-progress strip.
const OLLAMA_TRIGGER_GLASS_CLASSES =
	"group relative flex h-auto min-h-[3.25rem] w-full items-center justify-between gap-2 overflow-hidden rounded-lg border border-border bg-surface-3 px-3 py-2 text-left shadow-surface-2 transition-[transform,border-color,background-color,box-shadow] duration-150 ease-out hover:border-border-hover hover:bg-surface-4 hover:shadow-surface-3 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-accent/55 data-[state=open]:bg-accent/[0.06] data-[state=open]:ring-1 data-[state=open]:ring-accent/25";

/** Pick the most-progressed active pull as the one to surface on the trigger.
 *  When multiple pulls run concurrently this keeps the visible bar moving
 *  monotonically toward done rather than flickering between models. */
export function pickPrimaryPull(
	pulls: Readonly<Record<string, OllamaPullProgress>>,
): TriggerPullSummary | null {
	let best: TriggerPullSummary | null = null;
	for (const [name, progress] of Object.entries(pulls)) {
		const percent = Math.round(progress.percent ?? 0);
		if (!best || percent > best.percent) {
			best = { model: name, percent, status: progress.status };
		}
	}
	return best;
}

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
	isLoading: boolean;
	isSwitching: boolean;
	placeholder: string;
	selected: OllamaModel | undefined;
	toModel: OllamaModel | undefined;
	toName: string | undefined;
}

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
	if (props.selected) {
		return <SelectedTriggerContent model={props.selected} />;
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

export function OllamaTrigger(props: OllamaTriggerProps) {
	const { disabled, isLoading, isSwitching, activePull } = props;
	const ariaLabel = buildSwitchingAriaLabel(props);
	return (
		<Combobox.Trigger
			nativeButton
			render={(triggerProps) => (
				<Button
					{...(triggerProps as ComponentPropsWithoutRef<"button">)}
					aria-label={ariaLabel}
					className={`${OLLAMA_TRIGGER_GLASS_CLASSES} ${buildSwitchingClassName(isSwitching)}`}
					data-loading={isLoading || undefined}
					data-slot="ollama-model-selector-trigger"
					data-switching={isSwitching}
					disabled={disabled || isLoading || isSwitching}
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
			)}
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

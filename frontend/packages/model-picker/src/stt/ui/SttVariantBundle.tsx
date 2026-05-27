"use client";

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { cn } from "@/shared/lib/cn";
import { Tooltip } from "@/shared/ui/tooltip";
import { Collapsible } from "../../core/Collapsible";
import type { VariantBundle } from "../lib/family-helpers";
import { SttModelCard } from "./SttModelCard";

export interface SttVariantBundleProps {
	bundle: VariantBundle;
	currentQuantization: OnnxQuantization;
	/** Whether the bundle's nested variants are visible. */
	expanded: boolean;
	onSelect: (modelId: string, quantization?: OnnxQuantization) => void;
	/** Toggle handler — fires on chevron click; should not propagate to the row. */
	onToggleExpanded: (baseId: string) => void;
	selectedId: string | undefined;
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
}

/** Visual label for the variant-count chip on the trigger. */
function siblingChip(siblingCount: number): string {
	return siblingCount === 1 ? "+1 variant" : `+${siblingCount} variants`;
}

/**
 * Trigger button rendered inside the primary card's ``actions`` slot.
 *
 * Why a slot rather than absolute positioning: the previous chevron sat
 * ``absolute top-2 right-3`` and overlapped the right-edge AttributeGroup
 * whenever the model had a "Realtime" or "Multilingual" badge. Living
 * inside the card's flex layout makes that collision impossible by
 * construction.
 *
 * 12-principles applied (paired with the {@link Collapsible} below):
 *
 * - Secondary action: the chevron rotates 180deg on the same
 *   ``transition-transform duration-200`` as the panel's grid-row
 *   expand, so the two motions resolve in lockstep.
 * - Anticipation: the trigger lights up on hover before activation.
 */
function ExpandTrigger({
	baseId,
	expanded,
	onToggleExpanded,
	primaryName,
	siblingCount,
}: {
	baseId: string;
	expanded: boolean;
	onToggleExpanded: (baseId: string) => void;
	primaryName: string;
	siblingCount: number;
}) {
	const toggleVariantExpansion = (e: React.MouseEvent<HTMLButtonElement>) => {
		// Lives visually inside the primary card; intercept so the
		// Combobox.Item doesn't also fire its "select" action.
		e.preventDefault();
		e.stopPropagation();
		onToggleExpanded(baseId);
	};
	const chipLabel = siblingChip(siblingCount);
	return (
		<Tooltip
			content={expanded ? "Hide variants" : `Show ${chipLabel.replace("+", "").trim()}`}
			side="top"
		>
			<button
				aria-controls={`bundle-siblings-${baseId}`}
				aria-expanded={expanded}
				aria-label={
					expanded ? `Collapse ${primaryName} variants` : `Expand ${primaryName} variants`
				}
				className={cn(
					"inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5",
					"font-medium text-[10px] leading-none transition-colors",
					expanded
						? "bg-accent/15 text-accent ring-1 ring-accent/30"
						: "bg-surface-elevated/80 text-foreground-muted ring-1 ring-border hover:bg-surface-hover hover:text-foreground-secondary"
				)}
				onClick={toggleVariantExpansion}
				type="button"
			>
				<span className="tabular-nums">{chipLabel}</span>
				<HugeiconsIcon
					className={cn(
						"size-3 transition-transform duration-200 ease-out motion-reduce:transition-none",
						expanded && "rotate-180"
					)}
					icon={ArrowDown01Icon}
				/>
			</button>
		</Tooltip>
	);
}

/**
 * Render a {@link VariantBundle} as either a flat ``SttModelCard``
 * (singleton bundle) or a collapsible group whose primary is the base
 * architecture and whose hidden siblings are derivative variants —
 * ``.en`` English-only siblings and/or Lite-Whisper SVD compressions.
 *
 * Expansion uses the shared {@link Collapsible} (grid-template-rows
 * animation) so it shares its ease curve, duration, and a11y contract
 * with OpenRouter's hosting-provider drawer. Expansion state is owned
 * by the parent selector (one shared ``Set<string>``) so it survives
 * re-renders driven by filter / search changes.
 */
export function SttVariantBundle({
	bundle,
	currentQuantization,
	expanded,
	onSelect,
	onToggleExpanded,
	selectedId,
	statesById,
	systemInfo,
}: SttVariantBundleProps) {
	const [primary, ...siblings] = bundle.variants;
	if (primary === undefined) {
		return null;
	}
	const sharedCardProps = {
		currentQuantization,
		onSelect,
		selectedId,
		statesById,
		systemInfo,
	};
	if (siblings.length === 0) {
		// No siblings — flat card identical to the legacy rendering so
		// families without derivatives look unchanged.
		return <SttModelCard {...sharedCardProps} model={primary} state={statesById[primary.id]} />;
	}
	// "Has the user picked one of the hidden siblings?" — drives a softer
	// highlight on the primary so the bundle is findable at a glance even
	// when its strongest-highlight selected sibling lives below the chevron.
	const hasSelectedVariant = siblings.some((m) => m.id === selectedId);
	// Wrapper is a layout-only Fragment so the primary card keeps its own
	// `mx-2 my-1` outer margins — every SttModelCard in the list (singleton
	// or bundle primary) now resolves to the same `parent − 16px` width.
	// The bundle affordance lives in the chevron + "+N variants" chip in
	// the card's actions slot, plus the indented siblings panel below.
	return (
		<>
			<SttModelCard
				{...sharedCardProps}
				actions={
					<ExpandTrigger
						baseId={bundle.baseId}
						expanded={expanded}
						onToggleExpanded={onToggleExpanded}
						primaryName={primary.displayName}
						siblingCount={siblings.length}
					/>
				}
				hasSelectedVariant={hasSelectedVariant}
				model={primary}
				state={statesById[primary.id]}
			/>
			<Collapsible
				className={cn("px-2", expanded && "pb-1")}
				data-slot="stt-variant-siblings"
				isOpen={expanded}
			>
				<div
					className="ml-1 flex flex-col border-border/60 border-l-2 pl-1"
					id={`bundle-siblings-${bundle.baseId}`}
				>
					{siblings.map((m) => (
						<SttModelCard {...sharedCardProps} key={m.id} model={m} state={statesById[m.id]} />
					))}
				</div>
			</Collapsible>
		</>
	);
}

"use client";

import { Combobox } from "@base-ui/react/combobox";
import {
	AlertCircleIcon,
	CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Tooltip } from "@/shared/ui/tooltip";
import { CardMetaRow, type MetaEntry } from "./CardMeta";
import { PerfBars } from "./CardPerf";
import {
	CARD_BASE,
	CARD_NESTED,
	CARD_SELECTED,
	CARD_SELECTED_VARIANT,
	CARD_UNAVAILABLE,
	RECESSED_SHELF_CLASSES,
} from "./card-constants";
import { FavoriteToggle } from "./FavoriteToggle";

export interface ModelCardProps {
	/** Right-aligned action slot (e.g. expand chevron / "+N variants"). */
	actions?: ReactNode;
	/** Outer element. `combobox-item` = a selectable row (STT, OR model, Ollama
	 *  installed); `div` = a non-selectable / pull-only row (Ollama recommended,
	 *  library, custom). Default `combobox-item`. */
	as?: "combobox-item" | "div";
	/** Muted status badges (e.g. installed / downloading / paused) on their own
	 *  wrap row under the meta-line. */
	badges?: ReactNode;
	/** Merged last over the card classes (e.g. to override the default margin). */
	className?: string | undefined;
	"data-model-id"?: string | undefined;
	/** Two-line clamped description. */
	description?: ReactNode;
	errorMessage?: string | null | undefined;
	favorite?:
		| { isFavorited: boolean; label: string; onToggle: () => void }
		| undefined;
	/** Right-aligned action row pinned to the card's BOTTOM (e.g. OpenRouter's
	 *  providers-expand pill). Distinct from `actions`, which sits top-right beside
	 *  the favourite star. */
	footer?: ReactNode;
	/** Softer accent — a bundle primary whose selected variant is a hidden
	 *  sibling. */
	indirectlySelected?: boolean;
	/** Publisher logo / gray fallback chip, before the name. Omitted for STT
	 *  (the family lives in the group header). */
	makerIcon?: ReactNode;
	/** Homogeneous middot meta-line. */
	meta?: MetaEntry[] | undefined;
	/** Heterogeneous meta-line override (compose with `META_ROW_CLASSES` +
	 *  `MetaSeparator` for visual parity). Ignored when `meta` is set. */
	metaSlot?: ReactNode;
	name: string;
	nested?: boolean;
	/** Card-BODY click handler for non-selectable (`as="div"`) rows — e.g. the
	 *  Ollama recommended/library cards, where clicking the body selects/pulls the
	 *  model's recommended (default) tag. Selectable (`combobox-item`) rows select
	 *  through Base UI's `onValueChange` instead and ignore this. Shelf/action
	 *  controls `stopPropagation`, so they never bubble up to it. */
	onBodyClick?: (() => void) | undefined;
	perf?: { accuracyScore: number; speedScore: number } | null | undefined;
	selected?: boolean;
	/** Override the leading selection indicator. Default (combobox-item mode) is
	 *  the accent `Combobox.ItemIndicator` check. */
	selectionIndicator?: ReactNode;
	/** Recessed bottom shelf for picker-specific controls (precision badges,
	 *  download actions, …). */
	shelf?: ReactNode;
	/** Native title tooltip on the card element. */
	title?: string | undefined;
	/** Trailing action(s) after the favourite star (e.g. delete). */
	trailing?: ReactNode;
	unavailable?: boolean;
	/** Badge label when unavailable. Default "Broken". */
	unavailableLabel?: string;
	/** `Combobox.Item` value (selectable rows only). */
	value?: unknown;
}

/** The small error chip shown beside an unavailable model's name. */
function UnavailableBadge({
	errorMessage,
	label,
}: {
	errorMessage?: string | null | undefined;
	label: string;
}) {
	return (
		<Tooltip content={errorMessage || "Unavailable"} side="top">
			<span className="inline-flex shrink-0 items-center gap-1 rounded bg-error/15 px-1.5 py-0.5 font-medium text-[10px] text-error">
				<HugeiconsIcon className="size-3" icon={AlertCircleIcon} />
				{label}
			</span>
		</Tooltip>
	);
}

interface IdentityColumnProps {
	badges?: ReactNode;
	description?: ReactNode;
	errorMessage?: string | null | undefined;
	indicator: ReactNode;
	makerIcon?: ReactNode;
	metaRow: ReactNode;
	name: string;
	unavailable: boolean;
	unavailableLabel: string;
}

/** The left identity column: name-dominant top line + the subordinate
 *  meta-line / badges / description (or an error line when unavailable). */
function IdentityColumn({
	badges,
	description,
	errorMessage,
	indicator,
	makerIcon,
	metaRow,
	name,
	unavailable,
	unavailableLabel,
}: IdentityColumnProps) {
	return (
		<div className="flex min-w-0 flex-1 flex-col gap-1.5">
			<div className="flex min-w-0 items-center gap-1.5">
				{indicator}
				{makerIcon}
				<span className="min-w-0 truncate font-semibold text-body text-foreground leading-tight">
					{name}
				</span>
				{unavailable ? (
					<UnavailableBadge
						errorMessage={errorMessage}
						label={unavailableLabel}
					/>
				) : null}
			</div>
			{unavailable ? null : metaRow}
			{!unavailable && badges ? (
				<div className="flex w-fit max-w-full min-w-0 flex-wrap items-center gap-1 rounded-md bg-foreground/[0.025] px-1.5 py-1 ring-1 ring-white/[0.035]">
					{badges}
				</div>
			) : null}
			{!unavailable && description ? (
				<p className="line-clamp-2 text-[11px] text-foreground-muted leading-snug">
					{description}
				</p>
			) : null}
			{unavailable && errorMessage ? (
				<span className="truncate text-[11px] text-foreground-dim leading-tight">
					{errorMessage}
				</span>
			) : null}
		</div>
	);
}

interface RightClusterProps {
	actions?: ReactNode;
	favorite?:
		| { isFavorited: boolean; label: string; onToggle: () => void }
		| undefined;
	perf?: { accuracyScore: number; speedScore: number } | null | undefined;
	trailing?: ReactNode;
	unavailable: boolean;
}

/** The top-right module: perf bars + the actions/favourite/trailing cluster. */
function RightCluster({
	actions,
	favorite,
	perf,
	trailing,
	unavailable,
}: RightClusterProps) {
	return (
		<div className="flex shrink-0 items-start gap-3">
			{!unavailable && perf ? (
				<PerfBars
					accuracyScore={perf.accuracyScore}
					speedScore={perf.speedScore}
				/>
			) : null}
			<div className="flex items-center gap-0.5">
				{actions}
				{favorite && !unavailable ? (
					<FavoriteToggle
						isFavorited={favorite.isFavorited}
						label={favorite.label}
						onToggle={favorite.onToggle}
					/>
				) : null}
				{trailing}
			</div>
		</div>
	);
}

/**
 * The universal model card — the single source of visual identity shared by the
 * STT, Ollama, and OpenRouter pickers. A pure layout skeleton: each picker's
 * adapter feeds it picker-specific content via slots (meta, perf, description,
 * badges, favourite, actions, shelf) so the chrome is literally the same code
 * while the content differs.
 *
 * Expansion is external: provider grids (OpenRouter) and library tag grids
 * (Ollama) render as peer rows BELOW the card, owned by the picker's list.
 */
export function ModelCard({
	as = "combobox-item",
	value,
	className,
	title,
	"data-model-id": dataModelId,
	makerIcon,
	name,
	onBodyClick,
	selected = false,
	indirectlySelected = false,
	nested = false,
	unavailable = false,
	unavailableLabel = "Broken",
	errorMessage,
	selectionIndicator,
	meta,
	metaSlot,
	badges,
	description,
	perf,
	favorite,
	footer,
	actions,
	trailing,
	shelf,
}: ModelCardProps) {
	// A `div` card becomes body-clickable (select/pull the recommended tag) only
	// when given a handler and not unavailable — `combobox-item` rows select via
	// Base UI and ignore `onBodyClick`.
	const bodyClickable =
		as === "div" && !unavailable && onBodyClick !== undefined;
	const cardClass = cn(
		CARD_BASE,
		nested && CARD_NESTED,
		selected && CARD_SELECTED,
		indirectlySelected && CARD_SELECTED_VARIANT,
		unavailable && CARD_UNAVAILABLE,
		bodyClickable && "cursor-pointer",
		className,
	);

	const indicator =
		selectionIndicator ??
		(as === "combobox-item" ? (
			// Renders only when the Item's value matches the root's selected value
			// (Base UI resolves this) — no manual guard needed.
			<Combobox.ItemIndicator className="flex shrink-0 items-center">
				<HugeiconsIcon
					className="size-4 text-accent"
					icon={CheckmarkCircle02Icon}
				/>
			</Combobox.ItemIndicator>
		) : null);

	const body = (
		<>
			<div className="flex items-start justify-between gap-3">
				<IdentityColumn
					badges={badges}
					description={description}
					errorMessage={errorMessage}
					indicator={indicator}
					makerIcon={makerIcon}
					metaRow={meta ? <CardMetaRow entries={meta} /> : metaSlot}
					name={name}
					unavailable={unavailable}
					unavailableLabel={unavailableLabel}
				/>
				<RightCluster
					actions={actions}
					favorite={favorite}
					perf={perf}
					trailing={trailing}
					unavailable={unavailable}
				/>
			</div>
			{!unavailable && footer ? (
				<div className="flex items-center justify-end">{footer}</div>
			) : null}
			{!unavailable && shelf ? (
				<div className={RECESSED_SHELF_CLASSES}>{shelf}</div>
			) : null}
		</>
	);

	if (as === "combobox-item") {
		return (
			<Combobox.Item
				className={cardClass}
				data-model-id={dataModelId}
				disabled={unavailable}
				title={title}
				value={value as never}
			>
				{body}
			</Combobox.Item>
		);
	}
	if (bodyClickable) {
		return (
			<div
				className={cardClass}
				data-model-id={dataModelId}
				onClick={onBodyClick}
				onKeyDown={(e) => {
					// Activate on Enter/Space like a button — the badges/actions inside
					// already `stopPropagation`, so this only fires for the card body.
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onBodyClick?.();
					}
				}}
				role="button"
				tabIndex={0}
				title={title}
			>
				{body}
			</div>
		);
	}
	return (
		<div className={cardClass} data-model-id={dataModelId} title={title}>
			{body}
		</div>
	);
}

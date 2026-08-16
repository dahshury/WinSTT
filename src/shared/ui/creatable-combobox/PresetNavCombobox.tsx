import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { surfaceClasses, surfaceHoverBg } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { usePopupSurfaceLevels } from "@/shared/ui/select";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	CreatableCombobox,
	type CreatableComboboxGroup,
	type CreatableComboboxItem,
} from "./CreatableCombobox";

/** Every user-facing string the control renders. Passed in rather than read from
 *  a translation namespace here: this component lives on the `shared` layer and
 *  must not know which namespace its consumer's keys live under. */
export interface PresetNavComboboxLabels {
	/** Row label for the synthesized "create" affordance. */
	create: (name: string) => string;
	delete: string;
	empty: string;
	/** `aria-label` on the joined group wrapper. */
	group: string;
	next: string;
	placeholder: string;
	previous: string;
	reorder: (item: CreatableComboboxItem) => string;
	/** Revert the live state back to what the dirty row stores. */
	reset: string;
	/** Overwrite the dirty row with the current live state. */
	save: string;
}

export interface PresetNavComboboxProps {
	/** Wrapper width/placement classes for the combobox segment. */
	className?: string;
	disabled?: boolean;
	/** Row pinned to the bottom of the popup — see `CreatableCombobox`. */
	footerAction?: { label: string; onSelect: () => void } | undefined;
	/** Split the popup into titled sections — see `CreatableCombobox`. Omit for a
	 *  flat list. */
	groups?: readonly CreatableComboboxGroup[] | undefined;
	items: readonly CreatableComboboxItem[];
	labels: PresetNavComboboxLabels;
	onCreate?: ((name: string) => void) | undefined;
	onDelete?: ((id: string) => void) | undefined;
	onReorder?:
		| ((
				draggedId: string,
				targetId: string,
				placement: "before" | "after",
		  ) => void)
		| undefined;
	onReset?: ((id: string) => void) | undefined;
	onSave?: ((id: string) => void) | undefined;
	onSelect: (id: string) => void;
	/** Move the selection one entry back (`-1`) or forward (`+1`), wrapping. Only
	 *  called while the arrows render (two or more entries). */
	onStep: (offset: -1 | 1) => void;
	/** Selected entry id, `""` = none. */
	value: string;
}

/**
 * `[ ‹ | creatable combobox | › ]` — a named-preset picker with prev/next
 * navigation, rendered as ONE raised plate with hairline dividers.
 *
 * Extracted from the LLM post-processing profile control so a second named-list
 * feature (the TTS saved-voice library) gets identical chrome without a
 * widget→widget import, which the FSD checker rejects. All copy arrives through
 * `labels` so each consumer supplies its own translated strings.
 */
export function PresetNavCombobox({
	className,
	disabled = false,
	footerAction,
	groups,
	items,
	labels,
	onCreate,
	onDelete,
	onReorder,
	onReset,
	onSave,
	onSelect,
	onStep,
	value,
}: PresetNavComboboxProps) {
	const { triggerLevel } = usePopupSurfaceLevels({ selfElevate: false });
	// Nav arrows cycle prev/next between saved entries, so they only mean anything
	// with at least two. With 0 or 1 entry there is nothing to cycle to — and
	// rendering them permanently disabled sits a dimmed, "behind-level" segment on
	// either side of the fully-active combobox (opacity-40 kills the surface shadow
	// so they read as broken cutouts). Drop them entirely instead: the combobox
	// stands alone with full rounding, and the arrows reappear — enabled and
	// matching its surface — once a second entry exists. When they ARE shown, the
	// feature-level `disabled` greys the whole row (combobox + arrows) uniformly.
	const showNavigation = items.length >= 2;

	// ONE shared plate for the joined group: the wrapper carries the surface
	// fill + elevation shadow and every segment is transparent, so
	// [ < | field | > ] reads as a single raised control with hairline dividers.
	// (Per-segment surfaceClasses stacked three plates whose own shadow
	// hairlines/insets made the arrows look sunken next to the input.) Hover
	// brightens a segment one surface step — gated in JS rather than left to
	// CSS `hover:` alone, because `:hover` still matches on disabled buttons
	// and the arrows would glow while the whole group is switched off.
	const navButtonBase = cn(
		"h-8 w-9 shrink-0 bg-transparent text-foreground-dim transition-colors focus-visible:ring-inset focus-visible:ring-offset-0 disabled:cursor-not-allowed",
		!disabled &&
			cn(
				surfaceHoverBg(Math.min(triggerLevel + 1, 8)),
				"hover:text-foreground",
			),
	);

	return (
		<div
			aria-label={labels.group}
			className={cn(
				"flex min-w-0 items-center",
				// The plate only exists when the arrows render; standalone, the
				// combobox keeps its own surface + rounding.
				showNavigation &&
					cn("overflow-hidden rounded-lg", surfaceClasses(triggerLevel)),
			)}
			role="group"
		>
			{showNavigation ? (
				<Tooltip content={labels.previous}>
					<Button
						aria-label={labels.previous}
						// `border-solid` is required: the Button base sets `border-none`
						// (border-STYLE), so the `border-e` width alone never paints.
						className={cn(
							navButtonBase,
							"border-divider-strong border-e border-solid",
						)}
						disabled={disabled}
						onClick={() => onStep(-1)}
					>
						<HugeiconsIcon
							aria-hidden="true"
							icon={ArrowLeft01Icon}
							size={15}
						/>
					</Button>
				</Tooltip>
			) : null}
			<CreatableCombobox
				bareInput={showNavigation}
				className={className ?? "w-64 min-w-0 max-w-[40vw]"}
				createLabel={labels.create}
				deleteAriaLabel={labels.delete}
				disabled={disabled}
				emptyLabel={labels.empty}
				footerAction={footerAction}
				groups={groups}
				hideSelectedCheck
				// Square middle segment only when flanked by arrows; standalone it keeps
				// the base rounded-lg + normal (non-inset) focus ring.
				inputClassName={
					showNavigation
						? "rounded-none focus-visible:ring-inset focus-visible:ring-offset-0"
						: ""
				}
				items={items}
				leadingReorderHandle
				onCreate={onCreate}
				onDelete={onDelete}
				onReorder={onReorder}
				onReset={onReset}
				onSave={onSave}
				onSelect={onSelect}
				placeholder={labels.placeholder}
				reorderAriaLabel={labels.reorder}
				resetAriaLabel={labels.reset}
				saveAriaLabel={labels.save}
				value={value}
			/>
			{showNavigation ? (
				<Tooltip content={labels.next}>
					<Button
						aria-label={labels.next}
						className={cn(
							navButtonBase,
							"border-divider-strong border-s border-solid",
						)}
						disabled={disabled}
						onClick={() => onStep(1)}
					>
						<HugeiconsIcon
							aria-hidden="true"
							icon={ArrowRight01Icon}
							size={15}
						/>
					</Button>
				</Tooltip>
			) : null}
		</div>
	);
}

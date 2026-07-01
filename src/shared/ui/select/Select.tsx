import { Menu } from "@base-ui/react/menu";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/shared/lib/cn";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useRef } from "react";
import { SurfaceProvider, surfaceClasses } from "@/shared/lib/surface";
import { MenuHighlightLayer } from "@/shared/ui/menu-highlight";
import { GroupHeaderContent } from "./group-header";
import { OptionBadge } from "./option-badge";
import { StopBubble } from "./stop-bubble";
import { usePopupSurfaceLevels } from "./use-popup-surface-levels";

export interface SelectOption {
	/** Optional short badge text shown before the label (e.g. "US", "中") */
	badge?: string;
	/** When true the option is shown but can't be selected (e.g. a premium TTS
	 *  voice on a free plan). Row-trailing controls (preview) still work. */
	disabled?: boolean;
	/** Optional leading icon shown before the label */
	icon?: IconSvgElement;
	id: string;
	label: string;
	/** Optional compact content rendered at the far end of popup rows only. */
	trailing?: ReactNode;
}

/**
 * A labelled section of options rendered with a group header — the grouped-mode
 * counterpart of a flat `options` list. Shared by both pickers: `Select` renders
 * it with Base UI `Menu.Group`/`Menu.GroupLabel`, `SearchableSelect` with
 * `Combobox.Group`/`GroupLabel`. The wake-word picker passes one group per
 * engine, the cloud-STT picker one per provider, the TTS voice picker one per
 * country — the header's trailing badge carries the shared code so the per-row
 * badge can be dropped.
 *
 * Lives here (the more primitive layer) rather than in `SearchableSelect` so
 * `Select` can import it without a circular dependency; `SearchableSelect`
 * re-exports it for back-compat.
 */
export interface SelectOptionGroup {
	/** Optional short code shown as a badge at the header's trailing edge (e.g. "PVP"). */
	badge?: string;
	/** Optional leading icon node shown before the header label (e.g. a provider
	 *  brand mark). */
	icon?: ReactNode;
	/** Header text for the section (e.g. "Porcupine"). */
	label: string;
	options: readonly SelectOption[];
	/** Stable group identity. */
	value: string;
}

export interface SelectProps {
	"aria-label"?: string;
	/** Width / state classes for the trigger (e.g. `w-52`). The control is
	 *  self-contained (no wrapping `ElevatedSurface`), so pass width here. */
	className?: string | undefined;
	disabled?: boolean;
	/**
	 * Grouped options rendered with one `Menu.Group` header per section.
	 * Mutually exclusive with `options` (groups take precedence); the trigger's
	 * selected-value lookup still spans every group.
	 */
	groups?: readonly SelectOptionGroup[];
	onChange: (value: string) => void;
	onOpenChange?: (open: boolean) => void;
	/** Flat options. Ignored when `groups` is provided. */
	options?: readonly SelectOption[];
	value: string;
}

// Leading badge + icon + label, shared by the trigger (current value) and the
// option rows. `active` marks the selected/highlighted state so the leading
// icon thickens (strokeWidth 2) — the fluidfunctionalism dropdown's active cue.
function OptionContent({
	active,
	option,
}: {
	active?: boolean;
	option: SelectOption;
}) {
	return (
		<>
			{option.badge ? <OptionBadge text={option.badge} /> : null}
			{option.icon && (
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-muted"
					icon={option.icon}
					size={16}
					strokeWidth={active ? 2 : 1.5}
				/>
			)}
			<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
				{option.label}
			</span>
		</>
	);
}

// One option row, shared by the flat and grouped popup bodies. Stamped with
// `data-menu-option` — the contract the animated `MenuHighlightLayer` measures
// against (it scans the radio-group subtree, so rows nested inside a
// `Menu.Group` are found exactly like flat ones). Group headers deliberately
// carry no such attribute, so they are never measured as selectable rows.
function SelectRow({ option, value }: { option: SelectOption; value: string }) {
	const active = option.id === value;
	return (
		<Menu.RadioItem
			className="relative z-raised mx-1 flex cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-2.5 text-body text-foreground leading-normal outline-none data-[checked]:font-medium data-[checked]:text-foreground data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
			closeOnClick
			data-menu-option={option.id}
			disabled={option.disabled}
			value={option.id}
		>
			<OptionContent active={active} option={option} />
			{active ? (
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-accent"
					icon={Tick02Icon}
					size={16}
				/>
			) : null}
			{option.trailing ? (
				<StopBubble className="shrink-0">{option.trailing}</StopBubble>
			) : null}
		</Menu.RadioItem>
	);
}

// Section header for grouped mode — mirrors the SearchableSelect `GroupHeader`
// so the two pickers read as one family. The trailing badge carries the
// group's short code (engine / provider) so the per-row badge can be dropped.
function SelectGroupHeader({
	badge,
	icon,
	label,
}: {
	badge?: string | undefined;
	icon?: ReactNode;
	label: string;
}) {
	return (
		<Menu.GroupLabel className="flex items-center gap-2 border-border/60 border-b px-2 py-1.5">
			<GroupHeaderContent badge={badge} icon={icon} label={label} />
		</Menu.GroupLabel>
	);
}

export function Select({
	options,
	groups,
	value,
	onChange,
	onOpenChange,
	"aria-label": ariaLabel,
	className,
	disabled,
}: SelectProps) {
	// Grouped mode flattens for the trigger's selected-value lookup; the popup
	// still renders grouped.
	const flat = groups ? groups.flatMap((g) => [...g.options]) : (options ?? []);
	const selected = flat.find((o) => o.id === value);
	const selectedLabel = selected?.label ?? value;

	// Self-elevate +1 above the host panel so callers render a bare <Select/> with
	// no wrapping `ElevatedSurface`. Trigger then lifts +1 (its own bg+shadow; the
	// ring it used to borrow from the wrapper now lives on the trigger) and the
	// popup +2, re-providing substrate so option rows highlight against it.
	const { substrate, triggerLevel, popupLevel, popupShadow } =
		usePopupSurfaceLevels();

	// The radio group is the `position: relative` anchor the animated
	// selected/hover pills measure against (rows scroll inside `Menu.Popup`).
	const radioGroupRef = useRef<HTMLDivElement | null>(null);

	return (
		<SurfaceProvider value={substrate}>
			<Menu.Root onOpenChange={onOpenChange}>
				<Menu.Trigger
					aria-label={ariaLabel}
					className={cn(
						`flex h-8 w-full cursor-pointer select-none items-center justify-between gap-1.5 rounded-lg ${surfaceClasses(triggerLevel)} px-2.5 text-[13px] text-foreground leading-normal outline-none ring-1 ring-divider focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 disabled:cursor-not-allowed disabled:opacity-60`,
						className,
					)}
					disabled={disabled}
				>
					<span className="flex min-w-0 flex-1 items-center gap-2">
						{selected ? (
							<OptionContent active option={selected} />
						) : (
							<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
								{selectedLabel}
							</span>
						)}
					</span>
					<HugeiconsIcon
						className="shrink-0"
						icon={ArrowDown01Icon}
						size={14}
					/>
				</Menu.Trigger>
				<Menu.Portal>
					<SurfaceProvider value={popupLevel}>
						<Menu.Positioner
							className="z-popover outline-none"
							collisionPadding={8}
							sideOffset={4}
						>
							<Menu.Popup
								className={`select-popup min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-lg ${surfaceClasses(popupLevel, popupShadow)} py-1.5 [max-height:min(15rem,var(--available-height))] [max-width:var(--available-width)]`}
							>
								<Menu.RadioGroup
									className="relative"
									onValueChange={(v: string) => onChange(v)}
									ref={radioGroupRef}
									value={value}
								>
									<MenuHighlightLayer
										containerRef={radioGroupRef}
										value={value}
									/>
									{groups
										? groups.map((group) => (
												<Menu.Group className="flex flex-col" key={group.value}>
													<SelectGroupHeader
														badge={group.badge}
														icon={group.icon}
														label={group.label}
													/>
													{group.options.map((opt) => (
														<SelectRow
															key={opt.id}
															option={opt}
															value={value}
														/>
													))}
												</Menu.Group>
											))
										: flat.map((opt) => (
												<SelectRow key={opt.id} option={opt} value={value} />
											))}
								</Menu.RadioGroup>
							</Menu.Popup>
						</Menu.Positioner>
					</SurfaceProvider>
				</Menu.Portal>
			</Menu.Root>
		</SurfaceProvider>
	);
}

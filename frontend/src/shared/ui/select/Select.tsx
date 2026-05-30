import { Menu } from "@base-ui/react/menu";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	SurfaceProvider,
	surfaceCheckedBg,
	surfaceClasses,
	surfaceHighlightedBg,
	useSurface,
} from "@/shared/lib/surface";

export interface SelectOption {
	/** Optional short badge text shown before the label (e.g. "EN", "中") */
	badge?: string;
	/** When true the option is shown but can't be selected (e.g. a premium TTS
	 *  voice on a free plan). Row-trailing controls (preview) still work. */
	disabled?: boolean;
	/** Optional leading icon shown before the label */
	icon?: IconSvgElement;
	id: string;
	label: string;
}

export interface SelectProps {
	"aria-label"?: string;
	onChange: (value: string) => void;
	options: readonly SelectOption[];
	value: string;
}

function OptionContent({ option }: { option: SelectOption }) {
	return (
		<>
			{option.badge && (
				<span className="inline-flex h-4 min-w-[22px] shrink-0 items-center justify-center rounded-xs border border-border bg-surface-1 px-1 font-mono font-semibold text-[10px] text-foreground-secondary uppercase tracking-wider">
					{option.badge}
				</span>
			)}
			{option.icon && (
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-muted"
					icon={option.icon}
					size={14}
				/>
			)}
			<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
				{option.label}
			</span>
		</>
	);
}

export function Select({ options, value, onChange, "aria-label": ariaLabel }: SelectProps) {
	const selected = options.find((o) => o.id === value);
	const selectedLabel = selected?.label ?? value;

	// Trigger lifts +1 above substrate; popup lifts +2 and re-provides substrate
	// so children (option rows) highlight against the popup's own level.
	const substrate = useSurface();
	const triggerLevel = Math.min(substrate + 1, 8);
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	const highlightLevel = Math.min(popupLevel + 1, 8);
	// Checked row sits a step above hover so the current selection is
	// instantly readable against the popup — replaces the old translucent
	// accent tint which washed out against surface-N.
	const checkedLevel = Math.min(popupLevel + 2, 8);

	return (
		<Menu.Root>
			<Menu.Trigger
				aria-label={ariaLabel}
				className={`flex h-8 w-full cursor-pointer select-none items-center justify-between gap-1.5 rounded-sm ${surfaceClasses(triggerLevel)} px-2.5 text-body text-foreground leading-normal outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1`}
			>
				<span className="flex min-w-0 items-center gap-1.5">
					{selected ? (
						<OptionContent option={selected} />
					) : (
						<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
							{selectedLabel}
						</span>
					)}
				</span>
				<HugeiconsIcon className="shrink-0" icon={ArrowDown01Icon} size={14} />
			</Menu.Trigger>
			<Menu.Portal>
				<SurfaceProvider value={popupLevel}>
					<Menu.Positioner className="z-popover outline-none" collisionPadding={8} sideOffset={4}>
						<Menu.Popup
							className={`select-popup min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-sm ${surfaceClasses(popupLevel, popupShadow)} py-1 transition-[transform,opacity] duration-150 ease-out [max-height:min(15rem,var(--available-height))] [max-width:var(--available-width)]`}
						>
							<Menu.RadioGroup onValueChange={(v: string) => onChange(v)} value={value}>
								{options.map((opt) => (
									<Menu.RadioItem
										className={`mx-1 flex cursor-default select-none items-center gap-1.5 rounded-xs px-2.5 py-[7px] text-body text-foreground leading-normal outline-none ${surfaceHighlightedBg(highlightLevel)} ${surfaceCheckedBg(checkedLevel)} data-[checked]:font-medium data-[checked]:text-foreground data-[checked]:shadow-[inset_2px_0_0_0_var(--color-accent)]`}
										closeOnClick
										key={opt.id}
										value={opt.id}
									>
										<OptionContent option={opt} />
										{opt.id === value ? (
											<HugeiconsIcon
												aria-hidden="true"
												className="ms-auto shrink-0 text-accent"
												icon={Tick02Icon}
												size={14}
											/>
										) : null}
									</Menu.RadioItem>
								))}
							</Menu.RadioGroup>
						</Menu.Popup>
					</Menu.Positioner>
				</SurfaceProvider>
			</Menu.Portal>
		</Menu.Root>
	);
}

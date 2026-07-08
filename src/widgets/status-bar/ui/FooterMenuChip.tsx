import { Menu } from "@base-ui/react/menu";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	Fragment,
	type HTMLAttributes,
	type ReactNode,
	type Ref,
	useRef,
	useState,
} from "react";
import {
	MicrophoneLevelMeter,
	useMicrophoneLevels,
} from "@/entities/audio-device";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { MenuHighlightLayer } from "@/shared/ui/menu-highlight";
import {
	OptionDragHandle,
	type SelectOption,
	SortableOptionRows,
} from "@/shared/ui/select";
import { Tooltip } from "@/shared/ui/tooltip";

export const FOOTER_TOOLTIP_DELAY = 1500;

export interface FooterMenuChipProps {
	ariaLabel: string;
	icon: IconSvgElement;
	label: string;
	onChange: (id: string) => void;
	/** Enables drag-to-sort on rows marked `sortable` — same contract as the
	 *  settings `Select`: called with the sortable rows' ids in new order. */
	onReorder?: (orderedIds: string[]) => void;
	options: readonly SelectOption[];
	/** Accessible label for the per-row drag handle (reorder mode). */
	reorderHandleLabel?: string;
	tooltip: string;
	value: string;
}

function ChipRow({
	className,
	handleLabel,
	level,
	option,
	reorderable,
	value,
	...sortableProps
}: {
	handleLabel?: string | undefined;
	level: number;
	option: SelectOption;
	reorderable?: boolean;
	value: string;
} & HTMLAttributes<HTMLDivElement> & {
		ref?: Ref<HTMLDivElement> | undefined;
	}) {
	// In reorder mode the row renders inside `SortableItem asChild`;
	// `sortableProps` forwards dnd-kit's ref/style/attributes so the RadioItem
	// itself is the draggable (same pattern as the settings `SelectRow`).
	return (
		<Menu.RadioItem
			{...sortableProps}
			className={cn(
				"relative z-raised mx-1 flex cursor-pointer select-none items-center gap-1.5 rounded-xs px-2.5 py-[6px] text-body text-foreground leading-normal outline-none data-[checked]:font-medium data-[checked]:text-foreground",
				className,
			)}
			closeOnClick
			data-menu-option={option.id}
			value={option.id}
		>
			{reorderable ? (
				option.sortable ? (
					<OptionDragHandle className="-ml-1.5" label={handleLabel} />
				) : (
					<span aria-hidden="true" className="-ml-1.5 size-5 shrink-0" />
				)
			) : null}
			{option.icon ? (
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-muted"
					icon={option.icon}
					size={16}
					strokeWidth={option.id === value ? 2 : 1.5}
				/>
			) : null}
			<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
				{option.label}
			</span>
			<MicrophoneLevelMeter active={option.id === value} level={level} />
		</Menu.RadioItem>
	);
}

export function FooterMenuChip({
	ariaLabel,
	icon,
	label,
	onChange,
	onReorder,
	options,
	reorderHandleLabel,
	tooltip,
	value,
}: FooterMenuChipProps): ReactNode {
	const substrate = useSurface();
	const hoverLevel = Math.min(substrate + 2, 8);
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	const selected = options.find((opt) => opt.id === value);
	const triggerIcon = selected?.icon ?? icon;
	const [open, setOpen] = useState(false);
	// Same fence as the settings Select: rows go pointer-events-none while a
	// drag-sort is live so the drop's pointerup can't select-and-close.
	const [dragSorting, setDragSorting] = useState(false);
	const levels = useMicrophoneLevels(
		open,
		options.map((opt) => opt.id),
	);
	// `position: relative` anchor for the animated selected/hover pills.
	const radioGroupRef = useRef<HTMLDivElement | null>(null);
	const renderRow = (opt: SelectOption) => (
		<ChipRow
			handleLabel={reorderHandleLabel}
			level={levels[opt.id] ?? 0}
			option={opt}
			reorderable={Boolean(onReorder)}
			value={value}
		/>
	);
	return (
		<Menu.Root onOpenChange={setOpen}>
			<Tooltip content={tooltip} delay={FOOTER_TOOLTIP_DELAY} side="top">
				<Menu.Trigger
					aria-label={ariaLabel}
					className={`flex max-w-[180px] cursor-pointer select-none items-center gap-1 rounded-xs bg-transparent px-1 py-[1px] text-2xs text-foreground-secondary outline-none transition-colors ${surfaceHoverBg(hoverLevel)} focus-visible:ring-1 focus-visible:ring-accent`}
				>
					<HugeiconsIcon
						aria-hidden="true"
						color="var(--color-foreground-dim)"
						icon={triggerIcon}
						size={11}
					/>
					<span className="min-w-0 truncate">{label}</span>
					<HugeiconsIcon
						aria-hidden="true"
						className="shrink-0 text-foreground-dim"
						icon={ArrowDown01Icon}
						size={11}
					/>
				</Menu.Trigger>
			</Tooltip>
			<Menu.Portal>
				<SurfaceProvider value={popupLevel}>
					<Menu.Positioner
						align="end"
						className="z-popover outline-none"
						collisionPadding={8}
						side="top"
						sideOffset={6}
					>
						<Menu.Popup
							className={`select-popup min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-sm ${surfaceClasses(popupLevel, popupShadow)} py-1 transition-[transform,opacity] duration-150 ease-out [max-height:min(15rem,var(--available-height))] [max-width:var(--available-width)]`}
						>
							<Menu.RadioGroup
								className={cn(
									"relative",
									dragSorting && "[&_[data-menu-option]]:pointer-events-none",
								)}
								onValueChange={onChange}
								ref={radioGroupRef}
								value={value}
							>
								<MenuHighlightLayer
									containerRef={radioGroupRef}
									value={value}
								/>
								{onReorder ? (
									<SortableOptionRows
										onReorder={onReorder}
										onSortingChange={setDragSorting}
										options={options}
										renderRow={renderRow}
									/>
								) : (
									options.map((opt) => (
										<Fragment key={opt.id}>{renderRow(opt)}</Fragment>
									))
								)}
							</Menu.RadioGroup>
						</Menu.Popup>
					</Menu.Positioner>
				</SurfaceProvider>
			</Menu.Portal>
		</Menu.Root>
	);
}

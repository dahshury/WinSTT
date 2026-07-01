import { Menu } from "@base-ui/react/menu";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type ReactNode, useRef, useState } from "react";
import {
	MicrophoneLevelMeter,
	useMicrophoneLevels,
} from "@/entities/audio-device";
import {
	SurfaceProvider,
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { MenuHighlightLayer } from "@/shared/ui/menu-highlight";
import type { SelectOption } from "@/shared/ui/select";
import { Tooltip } from "@/shared/ui/tooltip";

export const FOOTER_TOOLTIP_DELAY = 1500;

export interface FooterMenuChipProps {
	ariaLabel: string;
	icon: IconSvgElement;
	label: string;
	onChange: (id: string) => void;
	options: readonly SelectOption[];
	tooltip: string;
	value: string;
}

export function FooterMenuChip({
	ariaLabel,
	icon,
	label,
	onChange,
	options,
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
	const levels = useMicrophoneLevels(
		open,
		options.map((opt) => opt.id),
	);
	// `position: relative` anchor for the animated selected/hover pills.
	const radioGroupRef = useRef<HTMLDivElement | null>(null);
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
								className="relative"
								onValueChange={onChange}
								ref={radioGroupRef}
								value={value}
							>
								<MenuHighlightLayer
									containerRef={radioGroupRef}
									value={value}
								/>
								{options.map((opt) => (
									<Menu.RadioItem
										className="relative z-raised mx-1 flex cursor-pointer select-none items-center gap-1.5 rounded-xs px-2.5 py-[6px] text-body text-foreground leading-normal outline-none data-[checked]:font-medium data-[checked]:text-foreground"
										closeOnClick
										data-menu-option={opt.id}
										key={opt.id}
										value={opt.id}
									>
										{opt.icon ? (
											<HugeiconsIcon
												aria-hidden="true"
												className="shrink-0 text-foreground-muted"
												icon={opt.icon}
												size={16}
												strokeWidth={opt.id === value ? 2 : 1.5}
											/>
										) : null}
										<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
											{opt.label}
										</span>
										<MicrophoneLevelMeter
											active={opt.id === value}
											level={levels[opt.id] ?? 0}
										/>
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

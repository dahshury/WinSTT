import { Menu } from "@base-ui/react/menu";
import { CheckIcon, Layout01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { RowData, Table } from "@tanstack/react-table";
import {
	SurfaceProvider,
	surfaceClasses,
	useSurface,
} from "@/shared/lib/surface";

/**
 * Dropdown of checkbox rows that toggle column visibility — one per hideable
 * leaf column. Built on the app's Base UI `Menu` + surface tokens so it matches
 * the rest of the dropdowns (Select, tray menus) rather than a shadcn popover.
 *
 * `embedded` renders a compact, hairline-ringed pill instead of the standalone
 * surfaced trigger — for nesting inside an input-group's trailing slot (next to
 * the grid's search field) so the two read as one grouped control.
 */
export function DataGridColumnVisibility({
	embedded = false,
	label,
	table,
}: {
	embedded?: boolean;
	label: string;
	table: Table<RowData>;
}) {
	const substrate = useSurface();
	const triggerLevel = Math.min(substrate + 1, 8);
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	const columns = table.getAllLeafColumns().filter((column) => column.getCanHide());

	const triggerClassName = embedded
		? "flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-2 text-2xs text-foreground-secondary outline-none ring-1 ring-divider transition-[background-color,color] duration-150 hover:bg-foreground/[0.04] hover:text-foreground hover:ring-border focus-visible:ring-2 focus-visible:ring-accent"
		: `flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md ${surfaceClasses(triggerLevel)} px-2.5 text-2xs text-foreground-secondary outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent`;

	return (
		<Menu.Root>
			<Menu.Trigger aria-label={label} className={triggerClassName}>
				<HugeiconsIcon aria-hidden="true" icon={Layout01Icon} size={14} />
				<span>{label}</span>
			</Menu.Trigger>
			<Menu.Portal>
				<SurfaceProvider value={popupLevel}>
					<Menu.Positioner
						className="z-popover outline-none"
						collisionPadding={8}
						sideOffset={4}
					>
						<Menu.Popup
							className={`min-w-[10rem] origin-[var(--transform-origin)] rounded-lg ${surfaceClasses(popupLevel, popupShadow)} py-1`}
						>
							{columns.map((column) => (
								<Menu.CheckboxItem
									checked={column.getIsVisible()}
									className="relative mx-1 flex cursor-default select-none items-center gap-2 rounded-xs py-1.5 pr-2 pl-7 text-body text-foreground outline-none transition-colors duration-100 data-[highlighted]:bg-surface-hover"
									closeOnClick={false}
									key={column.id}
									onCheckedChange={(checked) => column.toggleVisibility(checked)}
								>
									<Menu.CheckboxItemIndicator className="absolute left-2 flex items-center">
										<HugeiconsIcon
											aria-hidden="true"
											className="text-accent"
											icon={CheckIcon}
											size={14}
										/>
									</Menu.CheckboxItemIndicator>
									<span className="min-w-0 flex-1 truncate">
										{column.columnDef.meta?.title ?? column.id}
									</span>
								</Menu.CheckboxItem>
							))}
						</Menu.Popup>
					</Menu.Positioner>
				</SurfaceProvider>
			</Menu.Portal>
		</Menu.Root>
	);
}

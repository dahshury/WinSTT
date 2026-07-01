import type { Table } from "@tanstack/react-table";
import { Settings2 } from "@/shared/ui/data-grid/primitives/icons";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/shared/ui/data-grid/primitives/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/shared/ui/data-grid/primitives/command";
import { useDirection } from "@/shared/ui/data-grid/primitives/direction";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/shared/ui/data-grid/primitives/popover";
import { cn } from "@/shared/lib/cn";

interface DataGridViewMenuProps<TData> extends React.ComponentProps<
	typeof PopoverContent
> {
	table: Table<TData>;
	disabled?: boolean;
}

export function DataGridViewMenu<TData>({
	table,
	disabled,
	className,
	...props
}: DataGridViewMenuProps<TData>) {
	const t = useTranslations("dataGrid");
	const dir = useDirection();
	const [open, setOpen] = React.useState(false);
	const contentId = React.useId();

	const columns = table
		.getAllColumns()
		.filter(
			(column) =>
				typeof column.accessorFn !== "undefined" && column.getCanHide(),
		);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					aria-label="Toggle columns"
					role="combobox"
					aria-controls={contentId}
					aria-expanded={open}
					dir={dir}
					variant="outline"
					className="ms-auto hidden h-8 font-normal lg:flex"
					disabled={disabled}
				>
					<Settings2 className="text-muted-foreground" />
					{t("view")}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				id={contentId}
				dir={dir}
				className={cn("w-44 p-0", className)}
				{...props}
			>
				<Command>
					<CommandInput placeholder="Search columns..." />
					<CommandList>
						<CommandEmpty>{t("noColumnsFound")}</CommandEmpty>
						<CommandGroup>
							{columns.map((column) => (
								<CommandItem
									key={column.id}
									data-checked={column.getIsVisible()}
									onSelect={() =>
										column.toggleVisibility(!column.getIsVisible())
									}
								>
									<span className="truncate">
										{column.columnDef.meta?.label ?? column.id}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

import { useEffect } from "react";
import {
	ArrowDownUp,
	Check,
	ChevronsUpDown,
	GripVertical,
	ListFilter,
	Trash2,
} from "@/shared/ui/data-grid/primitives/icons";

export { Badge } from "@/shared/ui/data-grid/primitives/badge";
export { Button } from "@/shared/ui/data-grid/primitives/button";
export {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/shared/ui/data-grid/primitives/command";
export { useDirection } from "@/shared/ui/data-grid/primitives/direction";
export {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/shared/ui/data-grid/primitives/popover";
export {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/shared/ui/data-grid/primitives/select";
export {
	Sortable,
	SortableContent,
	SortableItem,
	SortableItemHandle,
	SortableOverlay,
} from "@/shared/ui/data-grid/primitives/sortable";
export { ArrowDownUp, Check, ChevronsUpDown, GripVertical, ListFilter, Trash2 };

export const REMOVE_MENU_ITEM_SHORTCUTS = new Set(["backspace", "delete"]);

function isTextEntryTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		(target instanceof HTMLElement && target.contentEditable === "true")
	);
}

export function useDataGridMenuShortcut(
	shortcutKey: string,
	setOpen: (value: (prev: boolean) => boolean) => void,
): void {
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (isTextEntryTarget(event.target)) {
				return;
			}

			if (
				event.key.toLowerCase() === shortcutKey &&
				(event.ctrlKey || event.metaKey) &&
				event.shiftKey
			) {
				event.preventDefault();
				setOpen((prev) => !prev);
			}
		}

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [shortcutKey, setOpen]);
}

import { useEffect } from "react";
import {
	Check,
	ChevronsUpDown,
	GripVertical,
	Trash2,
} from "@/shared/ui/data-grid/primitives/icons";

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
} from "@/shared/ui/data-grid/primitives/sortable";
export { Check, ChevronsUpDown, GripVertical, Trash2 };

export const REMOVE_MENU_ITEM_SHORTCUTS = new Set(["backspace", "delete"]);

function isTextEntryTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		(target instanceof HTMLElement && target.contentEditable === "true")
	);
}

/**
 * Ctrl/Cmd+Shift+`shortcutKey` fires `onTrigger`. The grid's controls are one
 * popover now, so this reports the intent ("show me filters") and the caller
 * decides whether that means opening at a view or closing again.
 */
export function useDataGridMenuShortcut(
	shortcutKey: string,
	onTrigger: () => void,
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
				onTrigger();
			}
		}

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [shortcutKey, onTrigger]);
}

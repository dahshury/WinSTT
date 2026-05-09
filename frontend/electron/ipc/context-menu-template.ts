import type { MenuItemConstructorOptions } from "electron";

export type ContextMenuItemType = "normal" | "checkbox" | "radio";

interface ContextMenuSharedItem {
	accelerator?: string;
	checked?: boolean;
	enabled?: boolean;
	id?: string;
	label?: string;
	role?: MenuItemConstructorOptions["role"];
	sublabel?: string;
	submenu?: ContextMenuTemplateItem[];
	type?: ContextMenuItemType;
	visible?: boolean;
}

export type ContextMenuTemplateItem = { type: "separator" } | ContextMenuSharedItem;

function applyOptionalTextFields(
	menuItem: MenuItemConstructorOptions,
	item: ContextMenuSharedItem
): void {
	if (item.label !== undefined) {
		menuItem.label = item.label;
	}
	if (item.sublabel !== undefined) {
		menuItem.sublabel = item.sublabel;
	}
	if (item.role !== undefined) {
		menuItem.role = item.role;
	}
	if (item.accelerator !== undefined) {
		menuItem.accelerator = item.accelerator;
	}
}

function applyOptionalStateFields(
	menuItem: MenuItemConstructorOptions,
	item: ContextMenuSharedItem
): void {
	if (item.enabled !== undefined) {
		menuItem.enabled = item.enabled;
	}
	if (item.visible !== undefined) {
		menuItem.visible = item.visible;
	}
	if (item.checked !== undefined) {
		menuItem.checked = item.checked;
	}
}

function toContextMenuItem(
	item: ContextMenuTemplateItem,
	onSelected: (id: string) => void
): MenuItemConstructorOptions {
	if (item.type === "separator") {
		return { type: "separator" };
	}

	const menuItem: MenuItemConstructorOptions = {
		type: item.type ?? "normal",
	};

	applyOptionalTextFields(menuItem, item);
	applyOptionalStateFields(menuItem, item);

	if (item.submenu !== undefined) {
		menuItem.submenu = convertContextMenuTemplate(item.submenu, onSelected);
	}
	if (item.id) {
		const { id } = item;
		menuItem.click = () => onSelected(id);
	}

	return menuItem;
}

export function convertContextMenuTemplate(
	template: ContextMenuTemplateItem[],
	onSelected: (id: string) => void
): MenuItemConstructorOptions[] {
	return template.map((item) => toContextMenuItem(item, onSelected));
}

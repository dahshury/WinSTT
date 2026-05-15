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

const TEXT_FIELDS = ["label", "sublabel", "role", "accelerator"] as const;
type TextField = (typeof TEXT_FIELDS)[number];

function applyOptionalTextFields(
	menuItem: MenuItemConstructorOptions,
	item: ContextMenuSharedItem
): void {
	for (const field of TEXT_FIELDS) {
		if (item[field] !== undefined) {
			(menuItem as Record<TextField, unknown>)[field] = item[field];
		}
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

function buildNonSeparatorItem(
	item: ContextMenuSharedItem,
	onSelected: (id: string) => void
): MenuItemConstructorOptions {
	const menuItem: MenuItemConstructorOptions = { type: item.type ?? "normal" };
	applyOptionalTextFields(menuItem, item);
	applyOptionalStateFields(menuItem, item);
	if (item.submenu !== undefined) {
		menuItem.submenu = convertContextMenuTemplate(item.submenu, onSelected);
	}
	const { id } = item;
	if (id) {
		menuItem.click = () => onSelected(id);
	}
	return menuItem;
}

function toContextMenuItem(
	item: ContextMenuTemplateItem,
	onSelected: (id: string) => void
): MenuItemConstructorOptions {
	if (item.type === "separator") {
		return { type: "separator" };
	}
	return buildNonSeparatorItem(item, onSelected);
}

export function convertContextMenuTemplate(
	template: ContextMenuTemplateItem[],
	onSelected: (id: string) => void
): MenuItemConstructorOptions[] {
	return template.map((item) => toContextMenuItem(item, onSelected));
}

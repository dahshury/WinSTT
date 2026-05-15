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
const STATE_FIELDS = ["enabled", "visible", "checked"] as const;
type TextField = (typeof TEXT_FIELDS)[number];
type StateField = (typeof STATE_FIELDS)[number];

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
	for (const field of STATE_FIELDS) {
		if (item[field] !== undefined) {
			(menuItem as Record<StateField, unknown>)[field] = item[field];
		}
	}
}

function resolveItemType(item: ContextMenuSharedItem): ContextMenuItemType {
	return item.type ?? "normal";
}

function attachSubmenu(
	menuItem: MenuItemConstructorOptions,
	item: ContextMenuSharedItem,
	onSelected: (id: string) => void
): void {
	if (item.submenu !== undefined) {
		menuItem.submenu = convertContextMenuTemplate(item.submenu, onSelected);
	}
}

function attachClickHandler(
	menuItem: MenuItemConstructorOptions,
	item: ContextMenuSharedItem,
	onSelected: (id: string) => void
): void {
	const { id } = item;
	if (id) {
		menuItem.click = () => onSelected(id);
	}
}

function buildNonSeparatorItem(
	item: ContextMenuSharedItem,
	onSelected: (id: string) => void
): MenuItemConstructorOptions {
	const menuItem: MenuItemConstructorOptions = { type: resolveItemType(item) };
	applyOptionalTextFields(menuItem, item);
	applyOptionalStateFields(menuItem, item);
	attachSubmenu(menuItem, item, onSelected);
	attachClickHandler(menuItem, item, onSelected);
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

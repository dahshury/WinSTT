import { isRecord } from "../lib/ipc-helpers";

type AppMenuActionHandler = () => void;

export type NormalizedAppMenuItem =
	| {
			type: "separator";
	  }
	| {
			type: "normal";
			label: string;
			enabled: boolean;
			checked?: boolean;
			accelerator?: string;
			actionId?: string;
			submenu?: NormalizedAppMenuItem[];
	  };

export type AppMenuBuiltItem =
	| {
			type: "separator";
	  }
	| {
			type: "normal";
			label: string;
			enabled: boolean;
			checked?: boolean;
			accelerator?: string;
			submenu?: AppMenuBuiltItem[];
			click?: () => void;
	  };

function toTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function isSeparator(rawItem: Record<string, unknown>): boolean {
	return rawItem.type === "separator";
}

function readEnabled(rawItem: Record<string, unknown>): boolean {
	return typeof rawItem.enabled === "boolean" ? rawItem.enabled : true;
}

function readChecked(rawItem: Record<string, unknown>): boolean | undefined {
	return typeof rawItem.checked === "boolean" ? rawItem.checked : undefined;
}

function assignDefined<T extends object, K extends keyof T>(
	target: T,
	key: K,
	value: T[K] | undefined
): void {
	if (value !== undefined) {
		target[key] = value;
	}
}

function pickNormalizedOptional(
	rawItem: Record<string, unknown>,
	submenu: NormalizedAppMenuItem[]
): Partial<Extract<NormalizedAppMenuItem, { type: "normal" }>> {
	const out: Partial<Extract<NormalizedAppMenuItem, { type: "normal" }>> = {};
	assignDefined(out, "checked", readChecked(rawItem));
	assignDefined(out, "accelerator", toTrimmedString(rawItem.accelerator));
	assignDefined(out, "actionId", toTrimmedString(rawItem.actionId));
	assignDefined(out, "submenu", submenu.length > 0 ? submenu : undefined);
	return out;
}

function normalizeNormalItem(rawItem: Record<string, unknown>): NormalizedAppMenuItem | null {
	const label = toTrimmedString(rawItem.label);
	if (!label) {
		return null;
	}
	const submenu = normalizeItems(rawItem.submenu);
	return {
		type: "normal",
		label,
		enabled: readEnabled(rawItem),
		...pickNormalizedOptional(rawItem, submenu),
	};
}

function normalizeOne(rawItem: unknown): NormalizedAppMenuItem | null {
	if (!isRecord(rawItem)) {
		return null;
	}
	if (isSeparator(rawItem)) {
		return { type: "separator" };
	}
	return normalizeNormalItem(rawItem);
}

function isNotNull<T>(value: T | null): value is T {
	return value !== null;
}

function normalizeItems(rawTemplate: unknown): NormalizedAppMenuItem[] {
	if (!Array.isArray(rawTemplate)) {
		return [];
	}
	const out: NormalizedAppMenuItem[] = [];
	for (const item of rawTemplate) {
		const normalized = normalizeOne(item);
		if (normalized !== null) {
			out.push(normalized);
		}
	}
	return out;
}

export function normalizeAppMenuTemplate(rawTemplate: unknown): NormalizedAppMenuItem[] {
	return normalizeItems(rawTemplate);
}

function resolveClickHandler(
	item: Extract<NormalizedAppMenuItem, { type: "normal" }>,
	actionHandlers: Readonly<Record<string, AppMenuActionHandler>>
): AppMenuActionHandler | undefined {
	return typeof item.actionId === "string" ? actionHandlers[item.actionId] : undefined;
}

function buildSubmenuMaybe(
	item: Extract<NormalizedAppMenuItem, { type: "normal" }>,
	actionHandlers: Readonly<Record<string, AppMenuActionHandler>>
): AppMenuBuiltItem[] | undefined {
	return item.submenu ? item.submenu.map((sub) => buildItem(sub, actionHandlers)) : undefined;
}

function wrapClick(clickHandler: AppMenuActionHandler | undefined): (() => void) | undefined {
	return clickHandler ? () => clickHandler() : undefined;
}

function pickBuiltOptional(
	item: Extract<NormalizedAppMenuItem, { type: "normal" }>,
	actionHandlers: Readonly<Record<string, AppMenuActionHandler>>
): Partial<Extract<AppMenuBuiltItem, { type: "normal" }>> {
	const out: Partial<Extract<AppMenuBuiltItem, { type: "normal" }>> = {};
	assignDefined(out, "checked", typeof item.checked === "boolean" ? item.checked : undefined);
	assignDefined(out, "accelerator", item.accelerator);
	assignDefined(out, "submenu", buildSubmenuMaybe(item, actionHandlers));
	assignDefined(out, "click", wrapClick(resolveClickHandler(item, actionHandlers)));
	return out;
}

function buildItem(
	item: NormalizedAppMenuItem,
	actionHandlers: Readonly<Record<string, AppMenuActionHandler>>
): AppMenuBuiltItem {
	if (item.type === "separator") {
		return { type: "separator" };
	}
	return {
		type: "normal",
		label: item.label,
		enabled: item.enabled,
		...pickBuiltOptional(item, actionHandlers),
	};
}

export function buildAppMenuTemplate(
	template: readonly NormalizedAppMenuItem[],
	actionHandlers: Readonly<Record<string, AppMenuActionHandler>>
): AppMenuBuiltItem[] {
	return template.map((item) => buildItem(item, actionHandlers));
}

export const __app_menu_template_test_helpers__ = {
	toTrimmedString,
	isSeparator,
	readEnabled,
	readChecked,
	assignDefined,
	pickNormalizedOptional,
	normalizeNormalItem,
	normalizeOne,
	isNotNull,
	resolveClickHandler,
	buildSubmenuMaybe,
	wrapClick,
	pickBuiltOptional,
};

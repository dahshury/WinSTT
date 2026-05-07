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
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeItems(rawTemplate: unknown): NormalizedAppMenuItem[] {
	if (!Array.isArray(rawTemplate)) {
		return [];
	}

	const normalized: NormalizedAppMenuItem[] = [];

	for (const rawItem of rawTemplate) {
		if (!isRecord(rawItem)) {
			continue;
		}

		if (rawItem.type === "separator") {
			normalized.push({ type: "separator" });
			continue;
		}

		const label = toTrimmedString(rawItem.label);
		if (!label) {
			continue;
		}

		const enabled = typeof rawItem.enabled === "boolean" ? rawItem.enabled : true;
		const checked = typeof rawItem.checked === "boolean" ? rawItem.checked : undefined;
		const accelerator = toTrimmedString(rawItem.accelerator);
		const actionId = toTrimmedString(rawItem.actionId);
		const submenu = normalizeItems(rawItem.submenu);

		normalized.push({
			type: "normal",
			label,
			enabled,
			...(typeof checked === "boolean" ? { checked } : {}),
			...(accelerator ? { accelerator } : {}),
			...(actionId ? { actionId } : {}),
			...(submenu.length > 0 ? { submenu } : {}),
		});
	}

	return normalized;
}

export function normalizeAppMenuTemplate(rawTemplate: unknown): NormalizedAppMenuItem[] {
	return normalizeItems(rawTemplate);
}

function buildItem(
	item: NormalizedAppMenuItem,
	actionHandlers: Readonly<Record<string, AppMenuActionHandler>>
): AppMenuBuiltItem {
	if (item.type === "separator") {
		return { type: "separator" };
	}

	const clickHandler =
		typeof item.actionId === "string" ? actionHandlers[item.actionId] : undefined;

	return {
		type: "normal",
		label: item.label,
		enabled: item.enabled,
		...(typeof item.checked === "boolean" ? { checked: item.checked } : {}),
		...(item.accelerator ? { accelerator: item.accelerator } : {}),
		...(item.submenu
			? { submenu: item.submenu.map((subItem) => buildItem(subItem, actionHandlers)) }
			: {}),
		...(clickHandler ? { click: () => clickHandler() } : {}),
	};
}

export function buildAppMenuTemplate(
	template: readonly NormalizedAppMenuItem[],
	actionHandlers: Readonly<Record<string, AppMenuActionHandler>>
): AppMenuBuiltItem[] {
	return template.map((item) => buildItem(item, actionHandlers));
}

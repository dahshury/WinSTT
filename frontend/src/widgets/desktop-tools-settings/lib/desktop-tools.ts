import { z } from "zod";

export type DesktopAppMenuTemplateItem =
	| { type: "separator" }
	| {
			label: string;
			enabled?: boolean;
			checked?: boolean;
			accelerator?: string;
			actionId?: string;
			submenu?: DesktopAppMenuTemplateItem[];
	  };

const menuItemSchema: z.ZodType<DesktopAppMenuTemplateItem> = z.lazy(() =>
	z.union([
		z.object({ type: z.literal("separator") }),
		z.object({
			label: z.string(),
			enabled: z.boolean().optional(),
			checked: z.boolean().optional(),
			accelerator: z.string().optional(),
			actionId: z.string().optional(),
			submenu: z.array(menuItemSchema).optional(),
		}),
	])
);

const menuTemplateSchema = z.array(menuItemSchema);

export const DEFAULT_APP_MENU_TEMPLATE: DesktopAppMenuTemplateItem[] = [
	{
		label: "WinSTT",
		submenu: [
			{ label: "Show Window", accelerator: "CmdOrCtrl+Shift+W", actionId: "show-main-window" },
			{ label: "Open Settings", accelerator: "CmdOrCtrl+,", actionId: "open-settings" },
			{ type: "separator" },
			{ label: "Hide Window", actionId: "hide-main-window" },
			{ label: "Quit", accelerator: "CmdOrCtrl+Q", actionId: "quit-app" },
		],
	},
];

export type MenuJsonParseResult =
	| { ok: true; template: DesktopAppMenuTemplateItem[] }
	| { ok: false; error: string };

function tryParseJson(source: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(source) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Invalid JSON: ${message}` };
	}
}

export function parseAppMenuTemplateJson(source: string): MenuJsonParseResult {
	const parsed = tryParseJson(source);
	if (!parsed.ok) {
		return parsed;
	}
	if (!Array.isArray(parsed.value)) {
		return { ok: false, error: "JSON root must be an array of menu items" };
	}
	const result = menuTemplateSchema.safeParse(parsed.value);
	if (!result.success) {
		return {
			ok: false,
			error: `Invalid menu template: ${result.error.issues.map((i) => i.message).join("; ")}`,
		};
	}
	return { ok: true, template: result.data };
}

export function appendBounded<T>(values: readonly T[], next: T, maxSize: number): T[] {
	const bounded = Math.max(1, maxSize);
	const merged = [...values, next];
	// Stryker disable next-line EqualityOperator: equivalent — `<` vs `<=` differ
	// only when `merged.length === bounded`. In both cases the function returns
	// the full merged array (the strict-less branch falls through to
	// `merged.slice(merged.length - bounded)` which equals `merged.slice(0)` →
	// the full array). Observable behaviour is identical.
	if (merged.length <= bounded) {
		return merged;
	}
	return merged.slice(merged.length - bounded);
}

export function formatTimestamp(epochMillis: number): string {
	return new Date(epochMillis).toLocaleTimeString();
}

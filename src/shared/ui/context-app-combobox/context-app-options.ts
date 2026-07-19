import type { ContextAppEntry } from "@/shared/api/ipc-client";

export interface ContextAppOption {
	exe: string;
	icon?: string | null;
	id: string;
	label: string;
	title?: string | null;
}

export function normalizeContextAppId(value: string): string {
	return value.trim().toLowerCase();
}

export function uniqueContextAppIds(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const id = normalizeContextAppId(value);
		if (id && !seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}
	return out;
}

function toOption(app: ContextAppEntry): ContextAppOption | null {
	const id = normalizeContextAppId(app.exe || app.id);
	if (!id) {
		return null;
	}
	return {
		id,
		exe: id,
		label: app.label || id,
		title: app.title ?? null,
		icon: app.icon ?? null,
	};
}

export function buildContextAppOptions(
	apps: readonly ContextAppEntry[],
	selectedValues: readonly string[] = [],
): ContextAppOption[] {
	const byId = new Map<string, ContextAppOption>();
	for (const app of apps) {
		const option = toOption(app);
		if (option) {
			byId.set(option.id, option);
		}
	}
	for (const raw of selectedValues) {
		const id = normalizeContextAppId(raw);
		if (id && !byId.has(id)) {
			byId.set(id, {
				id,
				exe: id,
				label: id,
				title: null,
				icon: null,
			});
		}
	}
	return [...byId.values()].toSorted((a, b) =>
		a.label
			.toLowerCase()
			.localeCompare(b.label.toLowerCase(), undefined, { sensitivity: "base" }),
	);
}

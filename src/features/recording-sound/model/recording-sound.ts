import type { SoundLibraryEntry } from "@/shared/config/settings-schema";

/** Stable identifier for the implicit "default" entry. Never persisted. */
const DEFAULT_SOUND_ID = "__winstt_default__";

/**
 * A row in the picker. Default is virtual (no path), customs are real files
 * in userData/sounds/ persisted in the settings store under `recordingSoundLibrary`.
 */
export interface SoundLibraryItem {
	id: string;
	isDefault: boolean;
	name: string;
	/** Absolute disk path. Empty string for the implicit default entry. */
	path: string;
}

export function defaultItem(name: string): SoundLibraryItem {
	return {
		id: DEFAULT_SOUND_ID,
		isDefault: true,
		name,
		path: "",
	};
}

export function entryToItem(entry: SoundLibraryEntry): SoundLibraryItem {
	return {
		id: entry.id,
		isDefault: false,
		name: entry.name,
		path: entry.path,
	};
}

/** True if a given item is the currently active recording sound. */
export function isActive(item: SoundLibraryItem, activePath: string): boolean {
	if (item.isDefault) {
		return activePath === "";
	}
	return item.path === activePath;
}

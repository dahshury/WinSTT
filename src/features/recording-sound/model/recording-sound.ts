import type { SoundLibraryEntry } from "@/shared/config/settings-schema";

/** Stable identifier for the implicit "default" entry. Never persisted. */
const DEFAULT_SOUND_ID = "__winstt_default__";
const BUILTIN_SOUND_PREFIX = "builtin:";

/**
 * Hard cap on user-added custom sounds. Built-ins are always present and don't
 * count toward it. Adding past this is rejected (browse + drag-drop) and the
 * picker disables its Add row once the library is full.
 */
export const MAX_CUSTOM_SOUNDS = 50;

const ADDITIONAL_BUILTIN_SOUNDS = [
	{
		id: "__winstt_builtin_handy_marimba_start__",
		name: "Marimba",
		path: `${BUILTIN_SOUND_PREFIX}marimba_start.wav`,
	},
	{
		id: "__winstt_builtin_ui_earcon_1__",
		name: "UI Earcon 1",
		path: `${BUILTIN_SOUND_PREFIX}recording_sound_ui_earcon_1.wav`,
	},
	{
		id: "__winstt_builtin_ui_earcon_4__",
		name: "UI Earcon 4",
		path: `${BUILTIN_SOUND_PREFIX}recording_sound_ui_earcon_4.wav`,
	},
] as const;

/**
 * A row in the picker. Built-ins are virtual/protected rows; customs are real
 * files in userData/sounds/ persisted under `recordingSoundLibrary`.
 */
export interface SoundLibraryItem {
	id: string;
	/** True for bundled rows. These are not persisted, renamed, or deleted. */
	isDefault: boolean;
	name: string;
	/** Empty for original default, builtin:<file> for bundled alternates, absolute path for customs. */
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

function builtInItem(
	sound: (typeof ADDITIONAL_BUILTIN_SOUNDS)[number],
): SoundLibraryItem {
	return {
		id: sound.id,
		isDefault: true,
		name: sound.name,
		path: sound.path,
	};
}

export function builtInItems(
	defaultName: string,
): [SoundLibraryItem, ...SoundLibraryItem[]] {
	return [
		defaultItem(defaultName),
		...ADDITIONAL_BUILTIN_SOUNDS.map(builtInItem),
	];
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
	if (item.path === "") {
		return activePath === "";
	}
	return item.path === activePath;
}

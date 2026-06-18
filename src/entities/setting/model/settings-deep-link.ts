import { windowOpenSettings } from "@/shared/api/ipc-client";

/**
 * Cross-window deep-link into a specific Settings section.
 *
 * The Settings window is a SEPARATE webview (its own JS context), so a sibling
 * window — the onboarding wizard, a tray surface — can't reach into its
 * `useSettingsTabStore` directly. Instead we hand off the desired tab through a
 * one-shot `localStorage` key (all WinSTT windows share an origin, so they share
 * `localStorage`) and then ask the backend to show/focus the Settings window.
 *
 *   - A FRESH Settings window reads + clears the key on mount (`takePendingSettingsSection`).
 *   - An ALREADY-OPEN Settings window hears the `storage` event in the other
 *     window and navigates live (`subscribePendingSettingsSection`).
 *
 * The stored value carries a monotonic suffix so clicking the SAME section twice
 * still mutates the value (and therefore still fires a `storage` event) — without
 * it, a repeat click would write an identical value and the spec lets the browser
 * skip the event. The suffix is split off before the section is handed back.
 */
const PENDING_SECTION_KEY = "winstt:pending-settings-section";

/** Section keys mirror the `Tabs.Panel value` strings in `SettingsPage`. */
function encodePending(section: string): string {
	// `Date.now()` guarantees a fresh value per call so the storage event always
	// fires; section keys never contain "@", so a single split round-trips cleanly.
	return `${section}@${Date.now()}`;
}

function decodePending(raw: string | null): string | null {
	if (!raw) {
		return null;
	}
	const section = raw.split("@")[0];
	return section ? section : null;
}

/**
 * Write the requested section, then show/focus the Settings window. Safe to call
 * whether or not the Settings window already exists.
 */
export function openSettingsToSection(section: string): void {
	if (typeof window !== "undefined") {
		try {
			window.localStorage.setItem(PENDING_SECTION_KEY, encodePending(section));
		} catch {
			// Storage unavailable — fall through and open the (default) window anyway.
		}
	}
	windowOpenSettings();
}

/** Read + clear any pending section. Call once when the Settings window mounts. */
export function takePendingSettingsSection(): string | null {
	if (typeof window === "undefined") {
		return null;
	}
	try {
		const raw = window.localStorage.getItem(PENDING_SECTION_KEY);
		if (raw) {
			window.localStorage.removeItem(PENDING_SECTION_KEY);
		}
		return decodePending(raw);
	} catch {
		return null;
	}
}

/**
 * Subscribe to live section requests from other windows. Returns an unsubscribe
 * fn. Only fires in windows OTHER than the one that wrote the value (per the
 * `storage` event contract), which is exactly the cross-window hand-off we want.
 */
export function subscribePendingSettingsSection(
	onSection: (section: string) => void,
): () => void {
	if (typeof window === "undefined") {
		return () => undefined;
	}
	const handler = (event: StorageEvent) => {
		if (event.key !== PENDING_SECTION_KEY) {
			return;
		}
		const section = decodePending(event.newValue);
		if (section) {
			onSection(section);
		}
	};
	window.addEventListener("storage", handler);
	return () => window.removeEventListener("storage", handler);
}

const releaseNoteModules: Record<string, string> = (() => {
	try {
		return import.meta.glob<string>("../content/release-notes/*.md", {
			eager: true,
			import: "default",
			query: "?raw",
		});
	} catch {
		// `import.meta.glob` is a Vite transform. Keep imports safe in Bun tests.
		return {};
	}
})();

const RELEASE_NOTE_PATH = /\/([^/]+)\.md$/;

export const WHATS_NEW_LAST_SEEN_KEY = "winstt:whats-new:last-seen-version";

export function releaseNotesForVersion(version: string): string | null {
	for (const [path, notes] of Object.entries(releaseNoteModules)) {
		if (RELEASE_NOTE_PATH.exec(path)?.[1] === version) {
			return notes;
		}
	}
	return null;
}

export function readLastSeenVersion(): string | null {
	try {
		return globalThis.localStorage?.getItem(WHATS_NEW_LAST_SEEN_KEY) ?? null;
	} catch {
		return null;
	}
}

export function writeLastSeenVersion(version: string): void {
	try {
		globalThis.localStorage?.setItem(WHATS_NEW_LAST_SEEN_KEY, version);
	} catch {
		// Release notes are non-critical. A disabled/full localStorage must never
		// interfere with the main window.
	}
}

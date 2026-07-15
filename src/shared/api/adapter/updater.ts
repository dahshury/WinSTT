// ── Updater facade ──────────────────────────────────────────────────────────────
// The Rust updater facade owns GitHub release selection, download/install state,
// and the shared status history. This bridge keeps the legacy IPC shape
// stable for the renderer.
//
// Shared updater facade used directly by renderer domain wrappers and runtime
// update-check subscriptions.

import { commands, type UpdaterCommandResult } from "@/bindings";

let updaterCheckPromise: Promise<UpdaterCommandResult> | null = null;

export async function checkAndDownloadUpdate(
	includePrereleaseUpdates?: boolean,
): Promise<UpdaterCommandResult> {
	if (updaterCheckPromise) {
		return updaterCheckPromise;
	}

	updaterCheckPromise = (async () => {
		const res = await commands.winsttUpdaterCheckAndDownload(
			includePrereleaseUpdates ?? null,
		);
		if (res.status === "error") {
			throw new Error(res.error);
		}
		return res.data;
	})();

	try {
		return await updaterCheckPromise;
	} finally {
		updaterCheckPromise = null;
	}
}

export async function installPendingUpdateAndRelaunch(): Promise<UpdaterCommandResult> {
	const res = await commands.winsttUpdaterInstall();
	if (res.status === "error") {
		throw new Error(res.error);
	}
	return res.data;
}

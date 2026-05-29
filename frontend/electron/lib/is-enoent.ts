/**
 * `true` when the value is a Node.js filesystem error whose `code` is
 * `"ENOENT"` (the file/directory does not exist).
 *
 * Used by best-effort WAV unlink / read paths in both the SQLite history
 * shell (`ipc/history.ts`) and the legacy relay history handlers
 * (`ipc/relay.ts`) to silence the "file already gone" case while still
 * surfacing every other error. Hoisted here so the two callers share one
 * implementation instead of each carrying a verbatim copy.
 */
export function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === "ENOENT"
	);
}

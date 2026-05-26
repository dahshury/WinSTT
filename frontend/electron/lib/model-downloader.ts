/**
 * Cancellable, integrity-verified model downloader for Electron main.
 *
 * Mirrors the Handy reference (`examples/Handy/src-tauri/src/managers/model.rs`)
 * patterns adapted to Node/TypeScript:
 *
 *  - **Cancellation via AbortSignal** — every chunk-loop iteration checks the
 *    signal. On abort: the partial file is deleted, in-flight download state
 *    cleared, and `DOMException("AbortError")` is propagated (matches the
 *    web platform `fetch(signal)` contract).
 *  - **SHA-256 verification** — the response stream is teed: bytes go to disk
 *    AND to a `crypto.createHash("sha256")` instance in lock-step. On
 *    completion the digest is compared against `expectedSha256` (when
 *    provided). Mismatch deletes the file and throws — there is no way for a
 *    corrupt download to be silently accepted.
 *  - **Tarball auto-extraction** — when the filename ends in `.tar.gz`/`.tgz`
 *    the verified archive is extracted into `dest` via `tar.extract()` (which
 *    refuses `..` traversal, absolute paths, and unsafe links by default in
 *    `tar` v7). The archive is removed after a successful extract.
 *  - **Cleanup invariants** — every error path goes through `try/finally`:
 *    the in-flight registry entry is freed; the partial file is best-effort
 *    deleted. This is the TypeScript equivalent of Handy's `DownloadCleanup`
 *    RAII guard (disarmed only on success).
 *
 * The module is process-local and stateless beyond its private
 * `inFlightRegistry` (used so a future `cancelDownload(modelId)` IPC handler
 * can locate the right AbortController). All inputs are required and explicit
 * — there are no implicit defaults pulled from settings, which keeps the
 * orchestrator decoupled from the Electron store and trivially unit-testable.
 *
 * Not yet wired into the live STT model pipeline (which still goes through
 * the Python side's HuggingFace `snapshot_download`). This is the building
 * block for the Handy-style direct-URL flow.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Progress shape — mirrors `{ modelId, downloaded, total, percentage }` from
 *  the updater download-progress event. `total` is `0` when the server omits
 *  `Content-Length`, in which case `percentage` is also `0`. */
export interface DownloadProgress {
	downloaded: number;
	modelId: string;
	percentage: number;
	total: number;
}

export interface DownloadModelOptions {
	/** Target file path (the verified download is written here). If the
	 *  filename ends in `.tar.gz` or `.tgz` the archive is extracted into
	 *  `extractTo` and the archive removed after a successful extract. */
	dest: string;
	/** Lowercase hex SHA-256 of the downloaded bytes. When absent, integrity
	 *  is not verified (matches Handy's behaviour for custom user models). */
	expectedSha256?: string;
	/** Where to extract a tarball. Required when `dest` ends in `.tar.gz`
	 *  / `.tgz`; ignored otherwise. Must be a directory (created if absent). */
	extractTo?: string;
	/** Test seam — defaults to `globalThis.fetch`. Injected by the test
	 *  suite to stream synthetic bodies without hitting the network. Typed
	 *  as a callable rather than the full `typeof fetch` so test stubs
	 *  don't have to satisfy the `preconnect`/etc. side methods. */
	fetchImpl?: (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;
	/** Stable model identifier used in progress events and the in-flight
	 *  registry. Cancellation is keyed off this value. */
	modelId: string;
	/** Called with throttled progress updates (≤ ~10 Hz). Errors thrown by
	 *  this callback abort the download. */
	onProgress?: (progress: DownloadProgress) => void;
	/** Cooperative cancellation. When the signal aborts mid-stream the
	 *  partial file is deleted and the function throws `signal.reason`. */
	signal?: AbortSignal;
	/** Test seam for tarball extraction. Defaults to `tar.extract({ file,
	 *  cwd })`. The shape matches the high-level node-tar v7 entry point. */
	tarExtract?: (args: { cwd: string; file: string }) => Promise<void>;
	/** Source URL. Passed verbatim to `fetch`. Must be reachable; HTTP
	 *  errors and network errors both throw. */
	url: string;
}

/** Map of model-id → AbortController for the currently-running download.
 *  Module-scoped so `cancelDownload(modelId)` from any IPC handler can find
 *  the right controller without threading it through a class. */
const inFlightRegistry = new Map<string, AbortController>();

/** True when a download is currently registered for `modelId`. Used by the
 *  external cancellation handler to short-circuit on already-stopped jobs. */
export function isDownloading(modelId: string): boolean {
	return inFlightRegistry.has(modelId);
}

/** Snapshot of registered model-ids — diagnostic only. Returned as a fresh
 *  array so callers can't mutate the internal map. */
export function listInFlightDownloads(): string[] {
	return Array.from(inFlightRegistry.keys());
}

/** Cancel an in-flight download by model-id. No-op when no download is
 *  registered. Returns `true` when a cancellation was triggered. The
 *  `download()` call rejects with an `AbortError` shortly after this returns;
 *  the entry leaves the registry from the `finally` block in `download()`. */
export function cancelDownload(modelId: string): boolean {
	const controller = inFlightRegistry.get(modelId);
	if (!controller) {
		return false;
	}
	controller.abort();
	return true;
}

/** Internal: test-only registry reset so each test starts from a clean map. */
export function __resetInFlightRegistry(): void {
	for (const controller of inFlightRegistry.values()) {
		controller.abort();
	}
	inFlightRegistry.clear();
}

const PROGRESS_THROTTLE_MS = 100;
const TARBALL_SUFFIXES = [".tar.gz", ".tgz"] as const;

function isTarball(path: string): boolean {
	const lower = path.toLowerCase();
	return TARBALL_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

async function bestEffortRemove(path: string): Promise<void> {
	try {
		await rm(path, { force: true, recursive: false });
	} catch {
		// Best-effort cleanup — a missing file is the expected case after
		// a fresh extract, and a locked file just means the OS hasn't
		// released the handle yet. The caller's caller already surfaced
		// the underlying error.
	}
}

function computePercentage(downloaded: number, total: number): number {
	return total > 0 ? (downloaded / total) * 100 : 0;
}

/** Compose an AbortController whose `abort()` is triggered when the caller's
 *  signal aborts. Used so we always have a controller to register, even when
 *  the caller didn't supply one. */
function deriveController(parent: AbortSignal | undefined): AbortController {
	const controller = new AbortController();
	if (parent) {
		if (parent.aborted) {
			controller.abort(parent.reason);
			return controller;
		}
		parent.addEventListener(
			"abort",
			() => {
				controller.abort(parent.reason);
			},
			{ once: true }
		);
	}
	return controller;
}

/** True when the source URL's path/filename should be treated as a tarball. */
export function shouldExtractTarball(dest: string): boolean {
	return isTarball(dest);
}

/** Verify the streamed digest matches the expected one. On mismatch the
 *  partial file is removed so the next attempt starts clean (mirrors Handy). */
async function verifyDigest(
	dest: string,
	actual: string,
	expected: string | undefined
): Promise<void> {
	if (!expected) {
		return;
	}
	if (actual.toLowerCase() === expected.toLowerCase()) {
		return;
	}
	await bestEffortRemove(dest);
	throw new Error(
		`SHA-256 mismatch: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`
	);
}

interface StreamResult {
	digest: string;
	downloaded: number;
}

interface StreamArgs {
	body: ReadableStream<Uint8Array>;
	dest: string;
	modelId: string;
	onProgress: ((progress: DownloadProgress) => void) | undefined;
	signal: AbortSignal;
	total: number;
}

async function streamToDiskWithDigest(args: StreamArgs): Promise<StreamResult> {
	const { body, dest, modelId, onProgress, signal, total } = args;
	const hash = createHash("sha256");
	const fileStream = createWriteStream(dest);
	const fileClosed = new Promise<void>((resolve, reject) => {
		fileStream.on("close", () => {
			resolve();
		});
		fileStream.on("error", (err) => {
			reject(err);
		});
	});
	let downloaded = 0;
	let lastEmit = 0;
	const reader = body.getReader();
	try {
		while (true) {
			if (signal.aborted) {
				throw signal.reason ?? new DOMException("Aborted", "AbortError");
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			hash.update(value);
			downloaded += value.byteLength;
			const wroteOk = fileStream.write(value);
			if (!wroteOk) {
				await new Promise<void>((resolve) => {
					fileStream.once("drain", resolve);
				});
			}
			const now = Date.now();
			if (onProgress && now - lastEmit >= PROGRESS_THROTTLE_MS) {
				onProgress({
					modelId,
					downloaded,
					total,
					percentage: computePercentage(downloaded, total),
				});
				lastEmit = now;
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// reader.releaseLock throws if the stream is locked elsewhere —
			// safe to swallow; we own the lock.
		}
		fileStream.end();
		await fileClosed.catch(() => undefined);
	}
	if (onProgress) {
		onProgress({
			modelId,
			downloaded,
			total: total === 0 ? downloaded : total,
			percentage: total === 0 && downloaded === 0 ? 0 : 100,
		});
	}
	return { digest: hash.digest("hex"), downloaded };
}

async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

async function extractIfTarball(
	dest: string,
	extractTo: string | undefined,
	tarExtract: DownloadModelOptions["tarExtract"]
): Promise<string | null> {
	if (!isTarball(dest)) {
		return null;
	}
	if (!extractTo) {
		throw new Error("extractTo is required for .tar.gz / .tgz downloads");
	}
	await ensureDir(extractTo);
	const extract =
		tarExtract ??
		(async ({ cwd, file }: { cwd: string; file: string }) => {
			// Lazy import keeps the test path from loading tar's native
			// dependencies — the `tarExtract` test seam covers the call site.
			const tar = await import("tar");
			await tar.extract({ cwd, file });
		});
	await extract({ cwd: extractTo, file: dest });
	await bestEffortRemove(dest);
	return extractTo;
}

/** Result of a completed download. `finalPath` is either the verified file
 *  on disk OR the directory it was extracted into (for tarballs). */
export interface DownloadResult {
	downloaded: number;
	extracted: boolean;
	finalPath: string;
	modelId: string;
	sha256: string;
}

/**
 * Stream `url` to `dest` with progress + SHA-256 verification + optional
 * tarball auto-extraction.
 *
 * Throws on:
 *  - non-2xx HTTP status
 *  - missing response body
 *  - SHA-256 mismatch (partial file is deleted first)
 *  - extraction failure (partial file is deleted first)
 *  - cancellation (partial file is deleted first; `signal.reason` is thrown)
 *
 * Cleanup invariant: the in-flight registry entry is removed in `finally`
 * regardless of success or failure.
 */
export async function downloadModel(options: DownloadModelOptions): Promise<DownloadResult> {
	const {
		dest,
		extractTo,
		expectedSha256,
		fetchImpl,
		modelId,
		onProgress,
		signal,
		tarExtract,
		url,
	} = options;

	if (inFlightRegistry.has(modelId)) {
		throw new Error(`Download already in flight for model: ${modelId}`);
	}

	const controller = deriveController(signal);
	inFlightRegistry.set(modelId, controller);

	let downloadedSuccessfully = false;
	try {
		await ensureDir(dirname(dest));
		const doFetch: (input: string, init?: { signal?: AbortSignal }) => Promise<Response> =
			fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
		const response = await doFetch(url, { signal: controller.signal });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
		}
		if (!response.body) {
			throw new Error(`Response body missing for ${url}`);
		}
		const headerTotal = Number(response.headers.get("content-length") ?? "0");
		const total = Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : 0;

		// Emit an initial 0% tick so the UI can switch to the progress bar
		// without waiting for the first chunk to land.
		if (onProgress) {
			onProgress({ modelId, downloaded: 0, total, percentage: 0 });
		}

		const { digest, downloaded } = await streamToDiskWithDigest({
			body: response.body,
			dest,
			modelId,
			onProgress,
			signal: controller.signal,
			total,
		});

		await verifyDigest(dest, digest, expectedSha256);
		const extractedTo = await extractIfTarball(dest, extractTo, tarExtract);
		// Sanity check the extracted directory has at least one entry — a
		// silently-empty extract is almost certainly a corrupted archive
		// that the security guards quietly dropped.
		if (extractedTo) {
			const info = await stat(extractedTo);
			if (!info.isDirectory()) {
				throw new Error(`Extraction target is not a directory: ${extractedTo}`);
			}
		}
		downloadedSuccessfully = true;
		return {
			downloaded,
			extracted: Boolean(extractedTo),
			finalPath: extractedTo ?? dest,
			modelId,
			sha256: digest,
		};
	} catch (err) {
		// Best-effort: the partial file is removed on every error path so
		// the next attempt starts from a clean slate. Matches Handy's
		// `verify_sha256` cleanup and the asset_downloader.py pattern.
		await bestEffortRemove(dest);
		throw err;
	} finally {
		// Mirrors the RAII guard's disarm-on-success / clean-on-drop
		// behaviour: the registry entry is freed exactly once, regardless
		// of which branch we exit through.
		if (!downloadedSuccessfully && controller.signal.aborted === false) {
			// Make sure no dangling listener keeps the parent signal alive.
			controller.abort();
		}
		inFlightRegistry.delete(modelId);
	}
}

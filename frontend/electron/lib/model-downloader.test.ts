import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__resetInFlightRegistry,
	cancelDownload,
	type DownloadProgress,
	downloadModel,
	isDownloading,
	listInFlightDownloads,
	shouldExtractTarball,
} from "./model-downloader";

type FetchSeam = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** Build a `Response` whose body emits the given chunks back-to-back. The
 *  `delay` lets tests interleave aborts between chunk reads. */
function buildResponse(
	chunks: Uint8Array[],
	opts: { contentLength?: number; delay?: number; status?: number } = {}
): Response {
	const { contentLength, delay = 0, status = 200 } = opts;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const chunk = chunks.shift();
			if (chunk) {
				if (delay > 0) {
					await new Promise<void>((resolve) => setTimeout(resolve, delay));
				}
				controller.enqueue(chunk);
				return;
			}
			controller.close();
		},
	});
	const headers = new Headers({ "content-type": "application/octet-stream" });
	if (contentLength != null) {
		headers.set("content-length", String(contentLength));
	}
	return new Response(stream, { headers, status });
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

let tempRoot: string;

beforeEach(async () => {
	__resetInFlightRegistry();
	tempRoot = await mkdtemp(join(tmpdir(), "winstt-dl-test-"));
});

afterEach(async () => {
	__resetInFlightRegistry();
	await rm(tempRoot, { force: true, recursive: true });
});

describe("downloadModel — happy path", () => {
	test("streams bytes to disk and returns the computed sha256", async () => {
		const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		const expectedDigest = sha256(payload);
		const dest = join(tempRoot, "model.bin");
		const fakeFetch: FetchSeam = async () =>
			buildResponse([payload], { contentLength: payload.byteLength });

		const result = await downloadModel({
			modelId: "tiny",
			url: "https://example/model.bin",
			dest,
			expectedSha256: expectedDigest,
			fetchImpl: fakeFetch,
		});

		expect(result.sha256).toBe(expectedDigest);
		expect(result.downloaded).toBe(payload.byteLength);
		expect(result.extracted).toBe(false);
		expect(result.finalPath).toBe(dest);
		const onDisk = await readFile(dest);
		expect(new Uint8Array(onDisk)).toEqual(payload);
	});

	test("emits progress events with the expected shape", async () => {
		// Multiple small chunks plus a delay so we can observe the throttled
		// progress timeline. Throttle is 100ms; with 10ms delays we'd batch
		// most ticks — what matters is that a final 100% tick always fires.
		const chunks = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])];
		const total = 8;
		const dest = join(tempRoot, "progress.bin");
		const events: DownloadProgress[] = [];
		const fakeFetch: FetchSeam = async () => buildResponse([...chunks], { contentLength: total });

		await downloadModel({
			modelId: "base",
			url: "https://example/progress.bin",
			dest,
			fetchImpl: fakeFetch,
			onProgress: (event) => {
				events.push(event);
			},
		});

		// Initial 0% and final 100% are always emitted.
		expect(events.length).toBeGreaterThanOrEqual(2);
		const first = events[0];
		const last = events.at(-1);
		if (!(first && last)) {
			throw new Error("progress events missing");
		}
		expect(first.modelId).toBe("base");
		expect(first.downloaded).toBe(0);
		expect(first.percentage).toBe(0);
		expect(last.downloaded).toBe(total);
		expect(last.percentage).toBe(100);
	});

	test("treats missing content-length as indeterminate (percentage stays 0)", async () => {
		const payload = new Uint8Array([42, 42, 42, 42]);
		const dest = join(tempRoot, "no-length.bin");
		const events: DownloadProgress[] = [];
		const fakeFetch: FetchSeam = async () => buildResponse([payload]);

		await downloadModel({
			modelId: "no-length",
			url: "https://example/no-length.bin",
			dest,
			fetchImpl: fakeFetch,
			onProgress: (event) => {
				events.push(event);
			},
		});

		expect(events[0]?.total).toBe(0);
		// Last tick now uses the downloaded count as the total.
		expect(events.at(-1)?.percentage).toBe(100);
	});
});

describe("downloadModel — sha256 verification", () => {
	test("throws on mismatch and removes the partial file", async () => {
		const payload = new Uint8Array([9, 9, 9, 9]);
		const wrongDigest = sha256(new Uint8Array([1, 2, 3]));
		const dest = join(tempRoot, "mismatch.bin");
		const fakeFetch: FetchSeam = async () =>
			buildResponse([payload], { contentLength: payload.byteLength });

		await expect(
			downloadModel({
				modelId: "mismatch",
				url: "https://example/mismatch.bin",
				dest,
				expectedSha256: wrongDigest,
				fetchImpl: fakeFetch,
			})
		).rejects.toThrow(/SHA-256 mismatch/);

		expect(existsSync(dest)).toBe(false);
	});

	test("skips verification when expectedSha256 is omitted", async () => {
		const payload = new Uint8Array([1, 1, 1, 1]);
		const dest = join(tempRoot, "no-verify.bin");
		const fakeFetch: FetchSeam = async () =>
			buildResponse([payload], { contentLength: payload.byteLength });

		const result = await downloadModel({
			modelId: "no-verify",
			url: "https://example/no-verify.bin",
			dest,
			fetchImpl: fakeFetch,
		});

		expect(result.sha256).toBe(sha256(payload));
		expect(existsSync(dest)).toBe(true);
	});

	test("accepts uppercase expected digest (case-insensitive compare)", async () => {
		const payload = new Uint8Array([2, 2, 2, 2]);
		const dest = join(tempRoot, "case.bin");
		const fakeFetch: FetchSeam = async () =>
			buildResponse([payload], { contentLength: payload.byteLength });

		const result = await downloadModel({
			modelId: "case",
			url: "https://example/case.bin",
			dest,
			expectedSha256: sha256(payload).toUpperCase(),
			fetchImpl: fakeFetch,
		});

		expect(result.sha256).toBe(sha256(payload));
	});
});

describe("downloadModel — cancellation", () => {
	test("aborting mid-stream rejects, deletes the partial file, and clears registry", async () => {
		const payload = new Uint8Array([1, 2, 3, 4]);
		const dest = join(tempRoot, "cancel.bin");

		// Slow body — gives us time to abort between chunks.
		const fakeFetch: FetchSeam = async () =>
			buildResponse([payload, payload, payload], {
				contentLength: payload.byteLength * 3,
				delay: 25,
			});

		const controller = new AbortController();
		const promise = downloadModel({
			modelId: "cancel-stream",
			url: "https://example/cancel.bin",
			dest,
			fetchImpl: fakeFetch,
			signal: controller.signal,
		});

		// Cancel after the first chunk has had a chance to arrive.
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
		controller.abort();

		await expect(promise).rejects.toThrow();
		expect(existsSync(dest)).toBe(false);
		expect(isDownloading("cancel-stream")).toBe(false);
	});

	test("cancelDownload(modelId) aborts an in-flight download", async () => {
		const payload = new Uint8Array([7, 7, 7, 7]);
		const dest = join(tempRoot, "external-cancel.bin");
		const fakeFetch: FetchSeam = async () =>
			buildResponse([payload, payload, payload, payload], {
				contentLength: payload.byteLength * 4,
				delay: 20,
			});

		const promise = downloadModel({
			modelId: "external",
			url: "https://example/external.bin",
			dest,
			fetchImpl: fakeFetch,
		});

		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		expect(listInFlightDownloads()).toContain("external");
		expect(cancelDownload("external")).toBe(true);

		await expect(promise).rejects.toThrow();
		expect(cancelDownload("external")).toBe(false); // already gone
		expect(existsSync(dest)).toBe(false);
	});

	test("rejects when a pre-aborted signal is passed", async () => {
		const controller = new AbortController();
		controller.abort();
		const dest = join(tempRoot, "pre-aborted.bin");
		const fakeFetch: FetchSeam = async (_url, init) => {
			if (init?.signal?.aborted) {
				throw new DOMException("Aborted", "AbortError");
			}
			return buildResponse([new Uint8Array([0])]);
		};

		await expect(
			downloadModel({
				modelId: "pre-aborted",
				url: "https://example/pre-aborted.bin",
				dest,
				signal: controller.signal,
				fetchImpl: fakeFetch,
			})
		).rejects.toThrow();

		expect(isDownloading("pre-aborted")).toBe(false);
	});
});

describe("downloadModel — http errors", () => {
	test("non-2xx status is surfaced as an error and registry is cleared", async () => {
		const dest = join(tempRoot, "404.bin");
		const fakeFetch: FetchSeam = async () =>
			new Response("", { status: 404, statusText: "Not Found" });

		await expect(
			downloadModel({
				modelId: "missing",
				url: "https://example/missing.bin",
				dest,
				fetchImpl: fakeFetch,
			})
		).rejects.toThrow(/HTTP 404/);
		expect(isDownloading("missing")).toBe(false);
		expect(existsSync(dest)).toBe(false);
	});

	test("missing response body is surfaced as an error", async () => {
		const dest = join(tempRoot, "no-body.bin");
		// A 204 No Content response has a null body in the fetch spec.
		const fakeFetch: FetchSeam = async () => new Response(null, { status: 204 });

		await expect(
			downloadModel({
				modelId: "no-body",
				url: "https://example/no-body.bin",
				dest,
				fetchImpl: fakeFetch,
			})
		).rejects.toThrow(/body missing/);
	});
});

describe("downloadModel — tarball extraction", () => {
	test("tar.gz files are extracted into extractTo and the archive removed", async () => {
		const payload = new Uint8Array([1, 2, 3, 4, 5]);
		const dest = join(tempRoot, "bundle.tar.gz");
		const extractTo = join(tempRoot, "bundle");
		const fakeFetch: FetchSeam = async () =>
			buildResponse([payload], { contentLength: payload.byteLength });

		let extractedFile = "";
		let extractedCwd = "";
		const result = await downloadModel({
			modelId: "bundle",
			url: "https://example/bundle.tar.gz",
			dest,
			extractTo,
			fetchImpl: fakeFetch,
			tarExtract: async ({ cwd, file }) => {
				extractedCwd = cwd;
				extractedFile = file;
				// Simulate tar.extract producing one file in `cwd`.
				await mkdir(cwd, { recursive: true });
				await writeFile(join(cwd, "manifest.txt"), "ok");
			},
		});

		expect(extractedCwd).toBe(extractTo);
		expect(extractedFile).toBe(dest);
		expect(result.extracted).toBe(true);
		expect(result.finalPath).toBe(extractTo);
		// Archive removed after a successful extract.
		expect(existsSync(dest)).toBe(false);
		// Extracted file present.
		expect(existsSync(join(extractTo, "manifest.txt"))).toBe(true);
		const dirInfo = await stat(extractTo);
		expect(dirInfo.isDirectory()).toBe(true);
	});

	test(".tgz suffix is treated the same as .tar.gz", async () => {
		expect(shouldExtractTarball("foo.tgz")).toBe(true);
		expect(shouldExtractTarball("FOO.TAR.GZ")).toBe(true);
		expect(shouldExtractTarball("foo.bin")).toBe(false);

		const payload = new Uint8Array([42]);
		const dest = join(tempRoot, "compact.tgz");
		const extractTo = join(tempRoot, "compact-out");
		const fakeFetch: FetchSeam = async () =>
			buildResponse([payload], { contentLength: payload.byteLength });
		let called = false;

		await downloadModel({
			modelId: "compact",
			url: "https://example/compact.tgz",
			dest,
			extractTo,
			fetchImpl: fakeFetch,
			tarExtract: async ({ cwd }) => {
				called = true;
				await mkdir(cwd, { recursive: true });
			},
		});
		expect(called).toBe(true);
	});

	test("extraction failure removes the partial file and throws", async () => {
		const payload = new Uint8Array([99, 99]);
		const dest = join(tempRoot, "broken.tar.gz");
		const extractTo = join(tempRoot, "broken-out");
		const fakeFetch: FetchSeam = async () =>
			buildResponse([payload], { contentLength: payload.byteLength });

		await expect(
			downloadModel({
				modelId: "broken",
				url: "https://example/broken.tar.gz",
				dest,
				extractTo,
				fetchImpl: fakeFetch,
				tarExtract: async () => {
					throw new Error("malformed archive");
				},
			})
		).rejects.toThrow(/malformed archive/);

		expect(existsSync(dest)).toBe(false);
		expect(isDownloading("broken")).toBe(false);
	});

	test("missing extractTo for a tarball download is reported as a config error", async () => {
		const payload = new Uint8Array([1]);
		const dest = join(tempRoot, "no-target.tar.gz");
		const fakeFetch: FetchSeam = async () => buildResponse([payload]);

		await expect(
			downloadModel({
				modelId: "no-target",
				url: "https://example/no-target.tar.gz",
				dest,
				fetchImpl: fakeFetch,
			})
		).rejects.toThrow(/extractTo is required/);

		expect(isDownloading("no-target")).toBe(false);
	});
});

describe("downloadModel — registry invariants", () => {
	test("rejects a second concurrent download for the same modelId", async () => {
		const payload = new Uint8Array([1, 2]);
		const dest = join(tempRoot, "first.bin");
		const dest2 = join(tempRoot, "second.bin");
		const fakeFetch: FetchSeam = async () =>
			buildResponse([payload], { contentLength: payload.byteLength, delay: 30 });

		const first = downloadModel({
			modelId: "twin",
			url: "https://example/first.bin",
			dest,
			fetchImpl: fakeFetch,
		});

		await expect(
			downloadModel({
				modelId: "twin",
				url: "https://example/second.bin",
				dest: dest2,
				fetchImpl: fakeFetch,
			})
		).rejects.toThrow(/already in flight/);

		await first;
		expect(isDownloading("twin")).toBe(false);
	});

	test("registry entry is cleared on the success path", async () => {
		const payload = new Uint8Array([1]);
		const dest = join(tempRoot, "ok.bin");
		const fakeFetch: FetchSeam = async () =>
			buildResponse([payload], { contentLength: payload.byteLength });

		await downloadModel({
			modelId: "ok",
			url: "https://example/ok.bin",
			dest,
			fetchImpl: fakeFetch,
		});

		expect(listInFlightDownloads()).toEqual([]);
	});

	test("fetch network error clears registry and removes partial file", async () => {
		const dest = join(tempRoot, "neterr.bin");
		const fakeFetch: FetchSeam = async () => {
			throw new TypeError("fetch failed");
		};

		await expect(
			downloadModel({
				modelId: "neterr",
				url: "https://example/neterr.bin",
				dest,
				fetchImpl: fakeFetch,
			})
		).rejects.toThrow(/fetch failed/);

		expect(isDownloading("neterr")).toBe(false);
		expect(existsSync(dest)).toBe(false);
	});
});

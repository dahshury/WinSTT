import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
// (afterEach/beforeEach are used by both the collectDroppedFiles and
//  enqueueDroppedFiles describe blocks.)
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import * as helpers from "../lib/audio-display-test-helpers";
import { AudioDisplay } from "./AudioDisplay";

const originalApi = window.nativeBridge;

afterEach(() => {
	window.nativeBridge = originalApi;
});

function makeFile(name: string): File {
	return new File(["x"], name, { type: "application/octet-stream" });
}

describe("AudioDisplay", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<AudioDisplay />
			</IntlProvider>,
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});

describe("AudioDisplay helpers — getExtension", () => {
	const cases: [string, string][] = [
		["song.MP3", ".mp3"],
		["movie.mp4", ".mp4"],
		["noext", ""],
		[".hidden", ".hidden"],
		["a.b.c.WAV", ".wav"],
	];
	test.each(cases)("getExtension(%s) -> %s", (name, expected) => {
		expect(helpers.getExtension(name)).toBe(expected);
	});
});

describe("AudioDisplay helpers — SUPPORTED_EXTENSIONS", () => {
	test("includes common audio + video extensions", () => {
		expect(helpers.SUPPORTED_EXTENSIONS.has(".mp3")).toBe(true);
		expect(helpers.SUPPORTED_EXTENSIONS.has(".mp4")).toBe(true);
		expect(helpers.SUPPORTED_EXTENSIONS.has(".webm")).toBe(true);
	});

	test("does not include unrelated extensions", () => {
		expect(helpers.SUPPORTED_EXTENSIONS.has(".txt")).toBe(false);
		expect(helpers.SUPPORTED_EXTENSIONS.has(".pdf")).toBe(false);
	});
});

describe("AudioDisplay helpers — collectDroppedFiles", () => {
	beforeEach(() => {
		window.nativeBridge = {
			...originalApi,
			getPathForFile: (file: File) => `/tmp/${file.name}`,
		};
	});

	test("keeps only supported extensions, preserving order", () => {
		const result = helpers.collectDroppedFiles([
			makeFile("one.mp3"),
			makeFile("doc.txt"),
			makeFile("two.mp4"),
			makeFile("image.png"),
		]);
		expect(result.map((f) => f.fileName)).toEqual(["one.mp3", "two.mp4"]);
		expect(result[0]?.filePath).toBe("/tmp/one.mp3");
	});

	test("drops files whose native path can't be resolved", () => {
		window.nativeBridge = { ...originalApi, getPathForFile: () => "" };
		const result = helpers.collectDroppedFiles([makeFile("song.mp3")]);
		expect(result).toEqual([]);
	});
});

describe("AudioDisplay helpers — enqueueDroppedFiles", () => {
	// `getFilePath` (inside collectDroppedFiles) reads
	// `window.nativeBridge.getPathForFile`, but `fileQueueEnqueue` routes through
	// the TYPED `commands.fileTranscribeEnqueue()` (IPC.FILE_QUEUE_ENQUEUE is in
	// `COMMAND_INVOKERS`), which calls `@tauri-apps/api/core` invoke →
	// `window.__TAURI_INTERNALS__.invoke("file_transcribe_enqueue")` — NOT
	// `nativeBridge.invoke`.
	//
	// HOWEVER bun:test's `mock.module` is process-global and never torn down, so
	// if the download-store suite (which mocks `@/shared/api/ipc-client`) ran
	// earlier in the same process, this file gets the LEAKED behaviour-faithful
	// fake whose `fileQueueEnqueue` routes through `nativeBridge.invoke` instead.
	// To stay order-independent we observe BOTH seams with one shared counter and
	// assert that an enqueue IPC was dispatched on whichever seam the live module
	// actually uses.
	type TauriInternals = {
		invoke: (
			cmd: string,
			args?: unknown,
			options?: unknown,
		) => Promise<unknown>;
		transformCallback: (
			cb?: (payload: unknown) => void,
			once?: boolean,
		) => number;
	};
	function tauriInternals(): TauriInternals {
		return (window as unknown as { __TAURI_INTERNALS__: TauriInternals })
			.__TAURI_INTERNALS__;
	}
	let savedTauriInvoke: TauriInternals["invoke"];
	let enqueueCalls: number;

	beforeEach(() => {
		enqueueCalls = 0;
		savedTauriInvoke = tauriInternals().invoke;
		// Real module → tauri internals seam.
		tauriInternals().invoke = ((cmd: string) => {
			if (cmd === "file_transcribe_enqueue") {
				enqueueCalls += 1;
				return Promise.resolve([]);
			}
			return Promise.resolve(undefined);
		}) as unknown as TauriInternals["invoke"];
		// Leaked-fake module → nativeBridge.invoke seam (IPC.FILE_QUEUE_ENQUEUE).
		window.nativeBridge = {
			...originalApi,
			getPathForFile: (file: File) => `/tmp/${file.name}`,
			invoke: ((channel: string) => {
				if (channel === "file:queue-enqueue") {
					enqueueCalls += 1;
				}
				return Promise.resolve(null);
			}) as typeof window.nativeBridge.invoke,
		};
	});

	afterEach(() => {
		tauriInternals().invoke = savedTauriInvoke;
	});

	test("does not enqueue renderer-resolved dropped file paths", async () => {
		const count = await helpers.enqueueDroppedFiles([
			makeFile("a.wav"),
			makeFile("skip.txt"),
		]);
		expect(count).toBe(0);
		expect(enqueueCalls).toBe(0);
	});

	test("returns 0 and does not enqueue when nothing is transcribable", async () => {
		const count = await helpers.enqueueDroppedFiles([makeFile("doc.txt")]);
		expect(count).toBe(0);
		expect(enqueueCalls).toBe(0);
	});
});

describe("AudioDisplay helpers — getContainerClassName", () => {
	test("omits border classes in listen mode", () => {
		const cls = helpers.getContainerClassName(true);
		expect(cls).not.toContain("rounded-lg");
		expect(cls).not.toContain("border ");
	});

	test("includes rounded corners outside listen mode", () => {
		const cls = helpers.getContainerClassName(false);
		expect(cls).toContain("rounded-lg");
	});
});

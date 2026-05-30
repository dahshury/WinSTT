import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { __audio_display_test_helpers__ as helpers } from "../lib/audio-display-test-helpers";
import { AudioDisplay } from "./AudioDisplay";

const originalApi = window.electronAPI;

afterEach(() => {
	window.electronAPI = originalApi;
});

function makeFile(name: string): File {
	return new File(["x"], name, { type: "application/octet-stream" });
}

describe("AudioDisplay", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<AudioDisplay />
			</IntlProvider>
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
		window.electronAPI = {
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
		window.electronAPI = { ...originalApi, getPathForFile: () => "" };
		const result = helpers.collectDroppedFiles([makeFile("song.mp3")]);
		expect(result).toEqual([]);
	});
});

describe("AudioDisplay helpers — enqueueDroppedFiles", () => {
	test("enqueues the collected files and returns the count", async () => {
		const invoke = mock(() => Promise.resolve(null));
		window.electronAPI = {
			...originalApi,
			getPathForFile: (file: File) => `/tmp/${file.name}`,
			invoke: invoke as unknown as typeof window.electronAPI.invoke,
		};
		const count = await helpers.enqueueDroppedFiles([makeFile("a.wav"), makeFile("skip.txt")]);
		expect(count).toBe(1);
		expect(invoke).toHaveBeenCalled();
	});

	test("returns 0 and does not enqueue when nothing is transcribable", async () => {
		const invoke = mock(() => Promise.resolve(null));
		window.electronAPI = {
			...originalApi,
			getPathForFile: (file: File) => `/tmp/${file.name}`,
			invoke: invoke as unknown as typeof window.electronAPI.invoke,
		};
		const count = await helpers.enqueueDroppedFiles([makeFile("doc.txt")]);
		expect(count).toBe(0);
		expect(invoke).not.toHaveBeenCalled();
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

import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { __audio_display_test_helpers__ as helpers } from "../lib/audio-display-test-helpers";
import { AudioDisplay } from "./AudioDisplay";

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

const tStub = ((key: string, vars?: Record<string, unknown>) =>
	vars ? `${key}:${JSON.stringify(vars)}` : key) as any;

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

describe("AudioDisplay helpers — validateDroppedFile", () => {
	test("returns ok=false when file is undefined", () => {
		const result = helpers.validateDroppedFile(undefined, tStub);
		expect(result.ok).toBe(false);
		expect(result.fileName).toBeUndefined();
	});

	test("rejects unsupported extension with error message", () => {
		const file = new File(["x"], "doc.txt", { type: "text/plain" });
		const result = helpers.validateDroppedFile(file, tStub);
		expect(result.ok).toBe(false);
		expect(result.fileName).toBe("doc.txt");
		expect(result.errorMessage).toContain("unsupportedFormat");
	});

	test("rejects supported file when getFilePath returns empty", () => {
		// In tests window.electronAPI.getPathForFile returns "" so a supported
		// extension still cannot resolve a path.
		const file = new File(["x"], "song.mp3", { type: "audio/mp3" });
		const result = helpers.validateDroppedFile(file, tStub);
		expect(result.ok).toBe(false);
		expect(result.errorMessage).toContain("cannotDetermineFilePath");
	});
});

describe("AudioDisplay helpers — extractErrorMessage", () => {
	test("uses Error.message when given an Error", () => {
		expect(helpers.extractErrorMessage(new Error("boom"), tStub)).toBe("boom");
	});

	test("falls back to translation key for non-Error", () => {
		expect(helpers.extractErrorMessage("nope", tStub)).toBe("transcriptionFailed");
	});
});

describe("AudioDisplay helpers — runTranscription", () => {
	test("calls setProcessing then completes via fileTranscribe (happy path)", async () => {
		const setProcessing = mock(() => undefined);
		const setError = mock(() => undefined);
		await helpers.runTranscription("song.mp3", "/tmp/song.mp3", {
			setProcessing,
			setError,
			tf: tStub,
		});
		expect(setProcessing).toHaveBeenCalledWith("song.mp3");
		// fileTranscribe is wrapped in invokeOrDefault which swallows errors,
		// so setError should not be called in the happy path.
		expect(setError).not.toHaveBeenCalled();
	});

	test("starts processing before resolving the transcription", async () => {
		const calls: string[] = [];
		const setProcessing = mock(() => {
			calls.push("processing");
		});
		const setError = mock(() => {
			calls.push("error");
		});
		await helpers.runTranscription("a.wav", "/p/a.wav", {
			setProcessing,
			setError,
			tf: tStub,
		});
		expect(calls[0]).toBe("processing");
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

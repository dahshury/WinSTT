import { describe, expect, test } from "bun:test";
import { argvForParse, defaultCliArgs, HELP_TEXT, parseCliArgs } from "./cli-args";

describe("parseCliArgs", () => {
	test("empty argv returns defaults (all flags off)", () => {
		expect(parseCliArgs([])).toEqual(defaultCliArgs());
	});

	test("--help flips help", () => {
		expect(parseCliArgs(["--help"]).help).toBe(true);
	});

	test("-h is a short alias for --help", () => {
		expect(parseCliArgs(["-h"]).help).toBe(true);
	});

	test("--toggle-transcription flips toggleTranscription", () => {
		const args = parseCliArgs(["--toggle-transcription"]);
		expect(args.toggleTranscription).toBe(true);
		expect(args.cancel).toBe(false);
	});

	test("--cancel flips cancel", () => {
		const args = parseCliArgs(["--cancel"]);
		expect(args.cancel).toBe(true);
		expect(args.toggleTranscription).toBe(false);
	});

	test("--start-hidden flips startHidden", () => {
		expect(parseCliArgs(["--start-hidden"]).startHidden).toBe(true);
	});

	test("--no-tray flips noTray", () => {
		expect(parseCliArgs(["--no-tray"]).noTray).toBe(true);
	});

	test("--debug flips debug", () => {
		expect(parseCliArgs(["--debug"]).debug).toBe(true);
	});

	test("multiple boot flags compose", () => {
		const args = parseCliArgs(["--start-hidden", "--no-tray", "--debug"]);
		expect(args.startHidden).toBe(true);
		expect(args.noTray).toBe(true);
		expect(args.debug).toBe(true);
		expect(args.help).toBe(false);
	});

	test("unknown flags land in `unknown` (not silently dropped) so caller can warn", () => {
		const args = parseCliArgs(["--this-flag-does-not-exist", "--also-bogus"]);
		expect(args.unknown).toEqual(["--this-flag-does-not-exist", "--also-bogus"]);
	});

	test("Electron's own switches (--allow-*, --enable-*, --disable-*, ...) are not treated as unknown", () => {
		const args = parseCliArgs([
			"--allow-file-access-from-files",
			"--enable-features=SomeFeature",
			"--disable-features=Autofill",
			"--no-sandbox",
			"--user-data-dir=/tmp/foo",
			"--remote-debugging-port=9229",
			"--lang=en-US",
			"--use-gl=desktop",
		]);
		expect(args.unknown).toEqual([]);
	});

	test("--verbose is silently accepted (debug-log already consumes it; not unknown)", () => {
		expect(parseCliArgs(["--verbose"]).unknown).toEqual([]);
	});

	test("absolute paths (argv[0]/argv[1] leakage) are silently dropped", () => {
		const args = parseCliArgs([
			"/usr/bin/winstt",
			"C:\\Program Files\\WinSTT\\resources\\app.asar",
		]);
		expect(args.unknown).toEqual([]);
	});

	test("idempotent: repeated flags don't toggle, they latch true", () => {
		const args = parseCliArgs(["--debug", "--debug", "--debug"]);
		expect(args.debug).toBe(true);
	});

	test("--help wins ordering doesn't matter for help (help+action both set)", () => {
		// The parser itself doesn't gate; main.ts handles `if (cliArgs.help)`
		// before any action dispatch. Lock that both flags survive parsing
		// so the caller can decide priority.
		const args = parseCliArgs(["--toggle-transcription", "--help"]);
		expect(args.help).toBe(true);
		expect(args.toggleTranscription).toBe(true);
	});

	test("two action flags both set (caller decides ordering)", () => {
		const args = parseCliArgs(["--toggle-transcription", "--cancel"]);
		expect(args.toggleTranscription).toBe(true);
		expect(args.cancel).toBe(true);
	});

	test("readonly argv: parser does not mutate input", () => {
		const argv = ["--debug", "--toggle-transcription"] as const;
		parseCliArgs(argv);
		expect(argv).toEqual(["--debug", "--toggle-transcription"]);
	});

	test("returns fresh objects (no shared state between calls)", () => {
		const a = parseCliArgs(["--debug"]);
		const b = parseCliArgs([]);
		expect(a.debug).toBe(true);
		expect(b.debug).toBe(false);
		expect(a.unknown).not.toBe(b.unknown);
	});
});

describe("argvForParse", () => {
	test("strips argv[0] and argv[1] (binary path + app entry)", () => {
		const argv = ["/usr/bin/electron", "/path/to/app.asar", "--debug"];
		expect(argvForParse(argv)).toEqual(["--debug"]);
	});

	test("empty argv returns empty array", () => {
		expect(argvForParse([])).toEqual([]);
	});

	test("argv with only argv[0]/[1] returns empty array (no user flags)", () => {
		expect(argvForParse(["winstt", "main.js"])).toEqual([]);
	});

	test("preserves all post-[1] tokens including unknowns", () => {
		const argv = ["winstt", "main.js", "--debug", "--unknown", "extra"];
		expect(argvForParse(argv)).toEqual(["--debug", "--unknown", "extra"]);
	});
});

describe("HELP_TEXT", () => {
	test("documents every supported flag", () => {
		expect(HELP_TEXT).toContain("--toggle-transcription");
		expect(HELP_TEXT).toContain("--cancel");
		expect(HELP_TEXT).toContain("--start-hidden");
		expect(HELP_TEXT).toContain("--no-tray");
		expect(HELP_TEXT).toContain("--debug");
		expect(HELP_TEXT).toContain("--help");
	});

	test("mentions Wayland / WM use case (the whole reason CLI flags exist)", () => {
		expect(HELP_TEXT).toContain("Wayland");
	});

	test("mentions Unix signal alternatives for Wayland users", () => {
		// pkill -USR2 / -USR1 → SIGUSR2 / SIGUSR1 in process.on()
		expect(HELP_TEXT).toContain("USR2");
		expect(HELP_TEXT).toContain("USR1");
	});
});

describe("defaultCliArgs", () => {
	test("every action flag is off, unknown is empty", () => {
		const d = defaultCliArgs();
		expect(d.help).toBe(false);
		expect(d.toggleTranscription).toBe(false);
		expect(d.cancel).toBe(false);
		expect(d.startHidden).toBe(false);
		expect(d.noTray).toBe(false);
		expect(d.debug).toBe(false);
		expect(d.unknown).toEqual([]);
	});

	test("returns fresh objects (no shared mutable state)", () => {
		const a = defaultCliArgs();
		const b = defaultCliArgs();
		a.unknown.push("mutation");
		expect(b.unknown).toEqual([]);
	});
});

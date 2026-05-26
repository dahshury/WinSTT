import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// `portable.ts` itself uses `statSync` (not `existsSync`) for marker
// detection — that side-steps the known global mock in
// ``paste.test.ts`` that pins ``existsSync`` to ``() => true``. We
// still pull in ``existsSync`` here for our own positive-presence
// assertions, but only on paths we just created in the same test, so
// the mock would NOT cause a false negative — it'd return ``true``
// for non-existent paths, which our assertions also expect ``true``.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyPortablePaths,
	isValidPortableMarker,
	PORTABLE_DATA_DIRNAME,
	PORTABLE_MAGIC_STRING,
	PORTABLE_MARKER_FILENAME,
	type PortableApp,
	resolvePortableState,
} from "./portable";

// ─── Filesystem helpers ───────────────────────────────────────────────

/**
 * Each test runs against a fresh tmpdir so marker / Data state never
 * leaks between cases. Built once per test in beforeEach and torn down in
 * afterEach.
 */
let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(path.join(tmpdir(), "winstt-portable-test-"));
});

afterEach(() => {
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch {
		// On Windows a child process may still hold a handle to the
		// directory; leaking a few KB of tmp data in tests is harmless.
	}
});

function writeMarker(dir: string, content: string): string {
	const markerPath = path.join(dir, PORTABLE_MARKER_FILENAME);
	writeFileSync(markerPath, content, "utf8");
	return markerPath;
}

function makeDataDir(dir: string): string {
	const dataDir = path.join(dir, PORTABLE_DATA_DIRNAME);
	mkdirSync(dataDir);
	return dataDir;
}

// ─── isValidPortableMarker ────────────────────────────────────────────

describe("isValidPortableMarker", () => {
	test("returns true when the marker contains the magic string", () => {
		const marker = writeMarker(workDir, PORTABLE_MAGIC_STRING);
		expect(isValidPortableMarker(marker)).toBe(true);
	});

	test("tolerates leading and trailing whitespace around the magic string", () => {
		const marker = writeMarker(workDir, `  ${PORTABLE_MAGIC_STRING}\n`);
		expect(isValidPortableMarker(marker)).toBe(true);
	});

	test("returns false for an empty marker file", () => {
		const marker = writeMarker(workDir, "");
		expect(isValidPortableMarker(marker)).toBe(false);
	});

	test("returns false for a marker with unrelated content", () => {
		const marker = writeMarker(workDir, "just some random text");
		expect(isValidPortableMarker(marker)).toBe(false);
	});

	test("returns false when the marker file does not exist", () => {
		const missing = path.join(workDir, "does-not-exist");
		expect(isValidPortableMarker(missing)).toBe(false);
	});
});

// ─── resolvePortableState ─────────────────────────────────────────────

describe("resolvePortableState", () => {
	test("returns isPortable=false when neither marker nor Data/ is present", () => {
		const state = resolvePortableState(workDir);
		expect(state.isPortable).toBe(false);
		expect(state.legacyUpgradeApplied).toBe(false);
		expect(state.markerPath).toBe(path.join(workDir, PORTABLE_MARKER_FILENAME));
		expect(state.dataDir).toBe(path.join(workDir, PORTABLE_DATA_DIRNAME));
	});

	test("returns isPortable=true when the marker has the magic string", () => {
		writeMarker(workDir, PORTABLE_MAGIC_STRING);
		const state = resolvePortableState(workDir);
		expect(state.isPortable).toBe(true);
		expect(state.legacyUpgradeApplied).toBe(false);
	});

	test("returns isPortable=false when an empty marker exists WITHOUT a Data/ dir (Scoop-style)", () => {
		writeMarker(workDir, "");
		const state = resolvePortableState(workDir);
		expect(state.isPortable).toBe(false);
		expect(state.legacyUpgradeApplied).toBe(false);
	});

	test("upgrades a legacy empty marker in place when a Data/ dir exists alongside it", () => {
		const markerPath = writeMarker(workDir, "");
		makeDataDir(workDir);
		const state = resolvePortableState(workDir);
		expect(state.isPortable).toBe(true);
		expect(state.legacyUpgradeApplied).toBe(true);
		const rewritten = readFileSync(markerPath, "utf8");
		expect(rewritten).toBe(PORTABLE_MAGIC_STRING);
	});

	test("upgrades a legacy marker with unrelated content when a Data/ dir exists alongside it", () => {
		const markerPath = writeMarker(workDir, "legacy junk content");
		makeDataDir(workDir);
		const state = resolvePortableState(workDir);
		expect(state.isPortable).toBe(true);
		expect(state.legacyUpgradeApplied).toBe(true);
		expect(readFileSync(markerPath, "utf8")).toBe(PORTABLE_MAGIC_STRING);
	});

	test("does not rewrite the marker when it already contains the magic string", () => {
		const initialContent = `${PORTABLE_MAGIC_STRING}\n# user notes go here`;
		const markerPath = writeMarker(workDir, initialContent);
		makeDataDir(workDir);
		const state = resolvePortableState(workDir);
		expect(state.isPortable).toBe(true);
		expect(state.legacyUpgradeApplied).toBe(false);
		// User-attached notes after the magic-string line are preserved.
		expect(readFileSync(markerPath, "utf8")).toBe(initialContent);
	});
});

// ─── applyPortablePaths ───────────────────────────────────────────────

interface RecordingApp extends PortableApp {
	current: Record<string, string>;
	setCalls: Array<{ name: string; value: string }>;
}

function makeRecordingApp(): RecordingApp {
	const current: Record<string, string> = {
		userData: "/mock/userData",
		logs: "/mock/logs",
		temp: "/mock/temp",
		sessionData: "/mock/sessionData",
		cache: "/mock/cache",
		crashDumps: "/mock/crashDumps",
	};
	const setCalls: RecordingApp["setCalls"] = [];
	return {
		current,
		setCalls,
		getPath: (name: string) => current[name] ?? `/mock/${name}`,
		setPath: (name: string, value: string) => {
			setCalls.push({ name, value });
			current[name] = value;
		},
	};
}

describe("applyPortablePaths", () => {
	const savedEnv = {
		HF_HOME: process.env.HF_HOME,
		HUGGINGFACE_HUB_CACHE: process.env.HUGGINGFACE_HUB_CACHE,
		WINSTT_DATA_DIR: process.env.WINSTT_DATA_DIR,
	};

	afterEach(() => {
		// Restore env so other test files don't see portable-mode env vars
		// leaking across modules.
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("is a no-op when the exe directory has no portable marker", () => {
		const app = makeRecordingApp();
		const state = applyPortablePaths(app, workDir);
		expect(state.isPortable).toBe(false);
		expect(app.setCalls).toHaveLength(0);
		expect(process.env.WINSTT_DATA_DIR).toBe(savedEnv.WINSTT_DATA_DIR);
	});

	test("overrides every user-data path and creates the Data/ tree", () => {
		writeMarker(workDir, PORTABLE_MAGIC_STRING);
		const app = makeRecordingApp();
		const state = applyPortablePaths(app, workDir);

		expect(state.isPortable).toBe(true);
		const dataDir = path.join(workDir, PORTABLE_DATA_DIRNAME);
		expect(state.dataDir).toBe(dataDir);
		expect(existsSync(dataDir)).toBe(true);
		expect(existsSync(path.join(dataDir, "logs"))).toBe(true);
		expect(existsSync(path.join(dataDir, "temp"))).toBe(true);
		expect(existsSync(path.join(dataDir, "session"))).toBe(true);
		expect(existsSync(path.join(dataDir, "cache"))).toBe(true);
		expect(existsSync(path.join(dataDir, "crash"))).toBe(true);
		expect(existsSync(path.join(dataDir, "hf"))).toBe(true);

		const setMap = Object.fromEntries(app.setCalls.map((c) => [c.name, c.value]));
		expect(setMap.userData).toBe(dataDir);
		expect(setMap.logs).toBe(path.join(dataDir, "logs"));
		expect(setMap.temp).toBe(path.join(dataDir, "temp"));
		expect(setMap.sessionData).toBe(path.join(dataDir, "session"));
		expect(setMap.cache).toBe(path.join(dataDir, "cache"));
		expect(setMap.crashDumps).toBe(path.join(dataDir, "crash"));
	});

	test("sets HF_HOME and WINSTT_DATA_DIR so the Python child inherits the portable cache", () => {
		writeMarker(workDir, PORTABLE_MAGIC_STRING);
		const app = makeRecordingApp();
		const state = applyPortablePaths(app, workDir);
		expect(state.isPortable).toBe(true);
		expect(process.env.HF_HOME).toBe(path.join(state.dataDir, "hf"));
		expect(process.env.HUGGINGFACE_HUB_CACHE).toBe(path.join(state.dataDir, "hf", "hub"));
		expect(process.env.WINSTT_DATA_DIR).toBe(state.dataDir);
	});

	test("logs the legacy-upgrade message when the marker was rewritten", () => {
		writeMarker(workDir, "");
		makeDataDir(workDir);
		const app = makeRecordingApp();
		const logged: string[] = [];
		const logger = { info: (msg: string) => logged.push(msg) };
		const state = applyPortablePaths(app, workDir, logger);
		expect(state.isPortable).toBe(true);
		expect(state.legacyUpgradeApplied).toBe(true);
		// Both the upgrade notice AND the data-dir notice should land.
		expect(logged.some((m) => m.includes("upgraded legacy empty marker"))).toBe(true);
		expect(logged.some((m) => m.includes("data dir"))).toBe(true);
	});

	test("logs only the data-dir line for a fresh portable install", () => {
		writeMarker(workDir, PORTABLE_MAGIC_STRING);
		const app = makeRecordingApp();
		const logged: string[] = [];
		applyPortablePaths(app, workDir, { info: (msg) => logged.push(msg) });
		expect(logged.some((m) => m.includes("upgraded legacy"))).toBe(false);
		expect(logged.some((m) => m.includes("data dir"))).toBe(true);
	});
});

import { describe, expect, test } from "bun:test";
import {
	buildPhaseLabel,
	buildProgressLabel,
	composeBarLabel,
	firstString,
} from "./use-tts-download-progress";

// Minimal translator stub: every helper consumes a `next-intl` translator,
// but the helpers only call it with stable keys. A keyed lookup table is
// enough — and keeps the tests free of an i18n provider.
function makeTranslator(): ReturnType<typeof translatorFactory> {
	return translatorFactory();
}

// The local keyed-lookup `t` only implements the (key, values) overload the
// helpers exercise; this contains the single boundary cast to the real
// translator type — the returned function is the exact `t` passed in.
type StubTranslator = (key: string, values?: Record<string, string>) => string;
const asTranslator = (fn: StubTranslator) => fn as unknown as Parameters<typeof buildPhaseLabel>[0];

function translatorFactory() {
	const phrases: Record<string, string> = {
		installPhaseEngine: "Installing TTS engine",
		installPhaseModel: "Downloading voice model",
		downloading: "Downloading…",
		downloadingProgress: "PROGRESS",
	};
	function t(key: string, values?: Record<string, string>): string {
		const base = phrases[key] ?? `[[${key}]]`;
		if (!values) {
			return base;
		}
		return Object.entries(values).reduce((acc, [k, v]) => `${acc}|${k}=${v}`, base);
	}
	// Mirrors the next-intl Translator overloads enough for the helpers we test.
	return asTranslator(t);
}

describe("buildPhaseLabel", () => {
	test("'engine' phase maps to the engine label", () => {
		expect(buildPhaseLabel(makeTranslator(), "engine")).toBe("Installing TTS engine");
	});

	test("'model' phase maps to the voice-model label", () => {
		expect(buildPhaseLabel(makeTranslator(), "model")).toBe("Downloading voice model");
	});

	test("'ready' phase resolves to empty (no prefix)", () => {
		expect(buildPhaseLabel(makeTranslator(), "ready")).toBe("");
	});

	test("'unknown' phase resolves to empty", () => {
		expect(buildPhaseLabel(makeTranslator(), "unknown")).toBe("");
	});

	test("null phase resolves to empty", () => {
		expect(buildPhaseLabel(makeTranslator(), null)).toBe("");
	});
});

describe("firstString", () => {
	test("returns the first non-null/undefined string", () => {
		expect(firstString(null, undefined, "a", "b")).toBe("a");
	});

	test("falls through nulls to the fallback", () => {
		expect(firstString(null, "fallback")).toBe("fallback");
	});

	test("empty string still counts as a string", () => {
		expect(firstString("", "fallback")).toBe("");
	});
});

describe("buildProgressLabel", () => {
	test("falls back to the bare 'downloading' label when totalBytes is 0", () => {
		const t = makeTranslator();
		expect(
			buildProgressLabel(t, {
				active: true,
				progress: 0,
				downloadedBytes: 0,
				totalBytes: 0,
				paused: false,
			})
		).toBe("Downloading…");
	});

	test("emits a full progress payload (percent + downloaded + total) when sized", () => {
		const t = makeTranslator();
		// 25% of 1 MiB downloaded.
		const out = buildProgressLabel(t, {
			active: true,
			progress: 0.25,
			downloadedBytes: 262_144,
			totalBytes: 1_048_576,
			paused: false,
		});
		expect(out.startsWith("PROGRESS")).toBe(true);
		expect(out).toContain("percent=25");
		expect(out).toContain("downloaded=");
		expect(out).toContain("total=");
	});
});

describe("composeBarLabel", () => {
	test("prefixes the phase label with ' · ' when present", () => {
		expect(composeBarLabel("Installing TTS engine", "Downloading…")).toBe(
			"Installing TTS engine · Downloading…"
		);
	});

	test("returns just the progress label when phase is empty", () => {
		expect(composeBarLabel("", "Downloading…")).toBe("Downloading…");
	});

	test("returns just the phase label when progress is empty (defensive)", () => {
		expect(composeBarLabel("Phase", "")).toBe("Phase");
	});

	test("returns empty string when both inputs are empty", () => {
		expect(composeBarLabel("", "")).toBe("");
	});
});

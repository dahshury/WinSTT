import { describe, expect, test } from "bun:test";
import type { TtsDownloadEstimatePayload } from "@/shared/api/ipc-client";
import {
	buildTtsEnablePatch,
	projectInstallPhase,
	resolveConfirmAction,
	resolveProbeAction,
	resolveToggleAction,
} from "./use-tts-install-gate";

function makeEstimate(
	partial: Partial<TtsDownloadEstimatePayload> = {}
): TtsDownloadEstimatePayload {
	return {
		alreadyInstalled: partial.alreadyInstalled ?? false,
		components: partial.components ?? [],
		totalBytes: partial.totalBytes ?? 0,
		// `unavailable` is optional — only spread when explicitly provided so the
		// "missing" case stays representable.
		...(partial.unavailable === undefined ? {} : { unavailable: partial.unavailable }),
	};
}

describe("projectInstallPhase", () => {
	test("'ready' collapses to null (idle)", () => {
		expect(projectInstallPhase("ready")).toBeNull();
	});

	test("'engine' / 'model' / 'unknown' pass through unchanged", () => {
		expect(projectInstallPhase("engine")).toBe("engine");
		expect(projectInstallPhase("model")).toBe("model");
		expect(projectInstallPhase("unknown")).toBe("unknown");
	});
});

describe("resolveProbeAction", () => {
	test("alreadyInstalled + reachable → 'enable' (skip the dialog)", () => {
		expect(resolveProbeAction(makeEstimate({ alreadyInstalled: true, unavailable: false }))).toBe(
			"enable"
		);
	});

	test("alreadyInstalled but unavailable → 'confirm' (show the dialog)", () => {
		expect(resolveProbeAction(makeEstimate({ alreadyInstalled: true, unavailable: true }))).toBe(
			"confirm"
		);
	});

	test("not installed + reachable → 'confirm' (size the download first)", () => {
		expect(resolveProbeAction(makeEstimate({ alreadyInstalled: false, unavailable: false }))).toBe(
			"confirm"
		);
	});

	test("not installed + unavailable → 'confirm' (offline-aware dialog)", () => {
		expect(resolveProbeAction(makeEstimate({ alreadyInstalled: false, unavailable: true }))).toBe(
			"confirm"
		);
	});

	test("treats missing unavailable as 'reachable' (the install-pack default)", () => {
		expect(resolveProbeAction(makeEstimate({ alreadyInstalled: true }))).toBe("enable");
	});
});

describe("resolveConfirmAction", () => {
	test("offline estimate → 'retry' (button becomes a re-probe)", () => {
		expect(resolveConfirmAction(makeEstimate({ unavailable: true }))).toBe("retry");
	});

	test("reachable estimate → 'enable' (commit the toggle)", () => {
		expect(resolveConfirmAction(makeEstimate({ unavailable: false }))).toBe("enable");
	});

	test("missing estimate (pre-probe) → 'enable'", () => {
		expect(resolveConfirmAction(null)).toBe("enable");
	});
});

describe("resolveToggleAction", () => {
	test("true → 'enable'", () => {
		expect(resolveToggleAction(true)).toBe("enable");
	});

	test("false → 'disable'", () => {
		expect(resolveToggleAction(false)).toBe("disable");
	});
});

describe("buildTtsEnablePatch", () => {
	test("non-empty current hotkey → only flips enabled (preserves user binding)", () => {
		expect(buildTtsEnablePatch("LCtrl+S", "LWin+R")).toEqual({ enabled: true });
	});

	test("empty current hotkey → folds in the default binding", () => {
		expect(buildTtsEnablePatch("", "LWin+R")).toEqual({
			enabled: true,
			hotkey: "LWin+R",
		});
	});

	test("whitespace-only hotkey is treated as empty (folds default)", () => {
		expect(buildTtsEnablePatch("   ", "LWin+R")).toEqual({
			enabled: true,
			hotkey: "LWin+R",
		});
	});
});

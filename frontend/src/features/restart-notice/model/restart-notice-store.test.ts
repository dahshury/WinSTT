import { beforeEach, describe, expect, test } from "bun:test";
// Capture the factory's initial state at module-load time, BEFORE any test
// runs setState(), so the snapshot reflects the source literals.
import { useRestartNotice } from "./restart-notice-store";

const INITIAL_STATE = useRestartNotice.getInitialState();

beforeEach(() => {
	useRestartNotice.setState({ current: null });
});

describe("useRestartNotice", () => {
	test("initial state has no current notice", () => {
		expect(useRestartNotice.getState().current).toBeNull();
	});

	test("factory initial-state literal is null (mutation guard)", () => {
		// At most one notice at a time; cold start must show nothing.
		expect(INITIAL_STATE.current).toBeNull();
	});

	test("show stores the setting + kind as the current notice ('unmanaged')", () => {
		useRestartNotice.getState().show("model.backend", "unmanaged");
		expect(useRestartNotice.getState().current).toEqual({
			setting: "model.backend",
			kind: "unmanaged",
		});
	});

	test("show stores the 'skew' kind too", () => {
		useRestartNotice.getState().show("audio.sampleRate", "skew");
		expect(useRestartNotice.getState().current).toEqual({
			setting: "audio.sampleRate",
			kind: "skew",
		});
	});

	test("newer show overwrites the older notice (at most one at a time)", () => {
		useRestartNotice.getState().show("first.setting", "unmanaged");
		useRestartNotice.getState().show("second.setting", "skew");
		expect(useRestartNotice.getState().current).toEqual({
			setting: "second.setting",
			kind: "skew",
		});
	});

	test("clear resets current back to null", () => {
		useRestartNotice.getState().show("model.backend", "unmanaged");
		useRestartNotice.getState().clear();
		expect(useRestartNotice.getState().current).toBeNull();
	});
});

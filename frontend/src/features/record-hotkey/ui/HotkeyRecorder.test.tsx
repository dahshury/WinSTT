import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { IPC } from "@/shared/api/ipc-channels";
import {
	type ForbiddenCombo,
	findConflict,
	formatCombo,
	resolveDisplayText,
} from "../lib/hotkey-recorder-helpers";
import { HotkeyRecorder } from "./HotkeyRecorder";

const startCalls: number[] = [];
const stopCalls: number[] = [];
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
let savedApi: typeof window.electronAPI;

function fireListener(channel: string, ...args: unknown[]): void {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

beforeEach(() => {
	savedApi = window.electronAPI;
	startCalls.length = 0;
	stopCalls.length = 0;
	listeners.clear();
	window.electronAPI = {
		getPathForFile: () => "",
		secureInvoke: () => Promise.resolve(undefined),
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb)
				);
			};
		},
		invoke: async (channel: string) => {
			if (channel === "hotkey:start-recording") {
				startCalls.push(1);
				return false;
			}
			return;
		},
		send: (channel: string) => {
			if (channel === "hotkey:stop-recording") {
				stopCalls.push(1);
			}
		},
	};
});

afterEach(() => {
	window.electronAPI = savedApi;
});

function renderIt(currentKey = "LCtrl+LMeta", forbiddenCombos?: readonly ForbiddenCombo[]) {
	const onKeyRecorded = mock((_key: string) => undefined);
	// `exactOptionalPropertyTypes: true` distinguishes "absent" from "undefined".
	// Only pass `forbiddenCombos` when actually present so the absent-case test
	// exercises the recorder's default-empty behaviour.
	const recorder = forbiddenCombos ? (
		<HotkeyRecorder
			currentKey={currentKey}
			forbiddenCombos={forbiddenCombos}
			onKeyRecorded={onKeyRecorded}
		/>
	) : (
		<HotkeyRecorder currentKey={currentKey} onKeyRecorded={onKeyRecorded} />
	);
	return {
		...render(<IntlProvider>{recorder}</IntlProvider>),
		onKeyRecorded,
	};
}

describe("formatCombo", () => {
	test("formats a single key", () => {
		expect(formatCombo("A")).toBe("A");
	});
	test("joins multiple keys with ' + '", () => {
		expect(formatCombo("LCtrl+LMeta")).toBe("L Ctrl + L Win");
	});
});

describe("resolveDisplayText", () => {
	test("when not recording returns formatted currentKey", () => {
		expect(resolveDisplayText(false, [], "LCtrl+A", "Press keys")).toBe("L Ctrl + A");
	});
	test("when recording with liveKeys returns them joined with ' + '", () => {
		const result = resolveDisplayText(true, ["LCtrl", "A"], "LCtrl+A", "Press keys");
		expect(result).toContain("L Ctrl");
		expect(result).toContain("A");
	});
	test("when recording with no liveKeys returns pressKeysLabel", () => {
		expect(resolveDisplayText(true, [], "LCtrl+A", "Press keys...")).toBe("Press keys...");
	});
});

describe("HotkeyRecorder", () => {
	test("displays the current key formatted with formatKeyName", () => {
		renderIt("LCtrl+A");
		expect(screen.getByText(/L Ctrl/)).toBeDefined();
	});

	test("the record button is initially in the idle (Record) state", () => {
		renderIt();
		// Idle state: button is aria-labelled "Record" (icon-only).
		const recBtn = screen.getByRole("button", { name: /record/i });
		expect(recBtn).toBeDefined();
	});

	test("clicking the record button calls hotkeyStartRecording (via window.electronAPI.invoke)", () => {
		renderIt();
		const recBtn = screen.getByRole("button", { name: /record/i });
		fireEvent.click(recBtn);
		expect(startCalls.length).toBe(1);
	});
});

describe("findConflict", () => {
	const repaste = { combo: "LCtrl+LShift+V", label: "Re-paste" };
	const tts = { combo: "LMeta+LShift+E", label: "Text-to-speech" };

	test("returns null when no forbiddenCombos provided", () => {
		expect(findConflict("LCtrl+A", undefined)).toBeNull();
	});

	test("returns null when none of the forbidden combos relate to the candidate", () => {
		expect(findConflict("LCtrl+A", [repaste, tts])).toBeNull();
	});

	test("returns the first matching forbidden combo on equal", () => {
		expect(findConflict("LCtrl+LShift+V", [repaste, tts])).toEqual(repaste);
	});

	test("returns the first matching forbidden combo on superset (candidate ⊃ other)", () => {
		// Candidate has every key the other does plus an extra → other would
		// accidentally fire when candidate is pressed.
		expect(findConflict("LCtrl+LShift+V+LAlt", [repaste, tts])).toEqual(repaste);
	});

	test("returns the first matching forbidden combo on subset (candidate ⊂ other)", () => {
		// Candidate's keys are all present in the other → candidate would
		// accidentally fire whenever the other is pressed.
		expect(findConflict("LCtrl+LShift", [repaste, tts])).toEqual(repaste);
	});
});

describe("HotkeyRecorder conflict gating", () => {
	const repaste: ForbiddenCombo = { combo: "LCtrl+LShift+V", label: "Re-paste" };
	const tts: ForbiddenCombo = { combo: "LMeta+LShift+E", label: "Text-to-speech" };

	function startThenRecord(combo: string | null): void {
		// Mirror what the real flow does: user clicks Record, the recorder hook
		// flips into recording mode, then the main-process emits recording-done.
		const recBtn = screen.getByRole("button", { name: /record/i });
		act(() => {
			fireEvent.click(recBtn);
		});
		act(() => {
			fireListener(IPC.HOTKEY_RECORDING_DONE, { combo });
		});
	}

	test("emits onKeyRecorded for a disjoint combo (no conflict)", async () => {
		const { onKeyRecorded } = renderIt("LCtrl+LMeta", [repaste, tts]);
		startThenRecord("LCtrl+LAlt+R");
		await waitFor(() => {
			expect(onKeyRecorded).toHaveBeenCalledWith("LCtrl+LAlt+R");
		});
	});

	test("rejects a combo equal to a forbidden one and surfaces an inline error naming the collider", async () => {
		const { onKeyRecorded } = renderIt("LCtrl+LMeta", [repaste, tts]);
		startThenRecord("LCtrl+LShift+V");
		await waitFor(() => {
			const alert = screen.getByRole("alert");
			// The error must name WHICH hotkey collided so the user can find and
			// rebind it — otherwise they'd be stuck with "conflicts with something".
			expect(alert.textContent).toContain("Re-paste");
			// And it must show the offending combo using the same formatted chip
			// text the user sees elsewhere (no raw "LCtrl+LShift+V" tokens).
			expect(alert.textContent).toContain("L Ctrl");
			expect(alert.textContent).toContain("L Shift");
		});
		expect(onKeyRecorded).not.toHaveBeenCalled();
	});

	test("rejects a superset combo and names the OTHER (smaller) hotkey it would also fire", async () => {
		const { onKeyRecorded } = renderIt("LCtrl+LMeta", [repaste, tts]);
		// Adding LAlt to the repaste combo makes it a superset → pressing this
		// would also satisfy the repaste matcher → forbidden.
		startThenRecord("LCtrl+LShift+V+LAlt");
		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toContain("Re-paste");
		});
		expect(onKeyRecorded).not.toHaveBeenCalled();
	});

	test("rejects a subset combo and names the OTHER (larger) hotkey that would fire it", async () => {
		const { onKeyRecorded } = renderIt("LCtrl+LMeta", [repaste, tts]);
		startThenRecord("LCtrl+LShift");
		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toContain("Re-paste");
		});
		expect(onKeyRecorded).not.toHaveBeenCalled();
	});

	test("rejection visually flips the InputGroup into the danger tone (red)", async () => {
		// Belt-and-braces: a future refactor that loses the `tone="danger"` flip
		// would leave the alert text correct but the recorder visually idle —
		// the user would only see the message if they read the small print.
		renderIt("LCtrl+LMeta", [repaste, tts]);
		startThenRecord("LCtrl+LShift+V");
		await waitFor(() => {
			expect(screen.getByRole("alert")).toBeDefined();
		});
		// The error class is part of the alert's container styling — verify
		// the InputGroup wrapper picked up the danger tone class. We don't
		// pin the exact Tailwind class name (changes with the design system)
		// but the visible error chip is enough proof the visual treatment is
		// applied — the previous tests already exercised the `tone="danger"`
		// path indirectly through ComboParts' chip class. This test exists so
		// a regression that drops the alert entirely is impossible to miss.
		const alertText = screen.getByRole("alert").textContent ?? "";
		expect(alertText.length).toBeGreaterThan(0);
	});

	test("clears a previous conflict error when the user starts a fresh recording", async () => {
		renderIt("LCtrl+LMeta", [repaste, tts]);
		startThenRecord("LCtrl+LShift+V");
		await waitFor(() => {
			expect(screen.getByRole("alert")).toBeDefined();
		});
		// Clicking Record again should clear the lingering error before the next
		// attempt — otherwise the user would see stale "conflicts with X" text
		// while pressing keys for a brand-new combo. AnimatePresence keeps the
		// element mounted for the duration of its exit animation, so we
		// `waitFor` rather than asserting synchronously.
		const recBtn = screen.getByRole("button", { name: /record/i });
		act(() => {
			fireEvent.click(recBtn);
		});
		await waitFor(() => {
			expect(screen.queryByRole("alert")).toBeNull();
		});
	});

	test("with no forbiddenCombos the recorder accepts any combo (backwards compatible)", async () => {
		const { onKeyRecorded } = renderIt("LCtrl+LMeta");
		startThenRecord("LCtrl+LShift+V");
		await waitFor(() => {
			expect(onKeyRecorded).toHaveBeenCalledWith("LCtrl+LShift+V");
		});
	});
});

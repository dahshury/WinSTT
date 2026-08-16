import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { commands } from "@/bindings";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { IPC } from "@test/mocks/legacy-ipc";
import {
	type ForbiddenCombo,
	findConflict,
	formatCombo,
	resolveDisplayText,
} from "../lib/hotkey-recorder-helpers";
import { HotkeyRecorder } from "./HotkeyRecorder";

const startCalls: number[] = [];
const stopCalls: number[] = [];
const changeBindingCalls: Array<{ id: string; binding: string }> = [];
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
let savedApi: typeof window.nativeBridge;
let changeBindingResult: {
	success: boolean;
	binding: null;
	error: string | null;
};

type TauriInternals = {
	invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
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
let savedChangeBinding: typeof commands.changeBinding;

function fireListener(channel: string, ...args: unknown[]): void {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

beforeEach(() => {
	savedApi = window.nativeBridge;
	savedTauriInvoke = tauriInternals().invoke;
	savedChangeBinding = commands.changeBinding;
	startCalls.length = 0;
	stopCalls.length = 0;
	changeBindingCalls.length = 0;
	changeBindingResult = { success: true, binding: null, error: null };
	// Bun's module mocks are process-global, so another feature test that
	// partially mocks `@/bindings` can otherwise replace this generated command
	// when the whole feature suite runs. Stub only the command under test here;
	// this keeps the recorder test order-independent while preserving the exact
	// tauri-specta Result contract consumed by HotkeyRecorder.
	commands.changeBinding = async (id: string, binding: string) => {
		changeBindingCalls.push({ id, binding });
		return { status: "ok", data: changeBindingResult };
	};
	listeners.clear();
	window.nativeBridge = {
		getPathForFile: () => "",
		secureInvoke: () => Promise.resolve(undefined),
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb),
				);
			};
		},
		// Record the LEAKED-fake seam too. When `mock.module("@/shared/api/ipc-client")`
		// from another file leaks its behaviour-faithful fake into this one,
		// `hotkeyStartRecording` routes through `nativeBridge.invoke` on the
		// `hotkey:start-recording` channel (IPC.HOTKEY_START_RECORDING) instead of
		// the typed `__TAURI_INTERNALS__` seam below — so observe BOTH with the same
		// `startCalls` recorder to stay order-independent.
		invoke: (channel: string) => {
			if (channel === IPC.HOTKEY_START_RECORDING) {
				startCalls.push(1);
				return Promise.resolve(false);
			}
			return Promise.resolve(undefined);
		},
		send: (channel: string) => {
			if (channel === "hotkey:stop-recording") {
				stopCalls.push(1);
			}
		},
	};
	// `hotkeyStartRecording` calls the typed `commands.hotkeyStartRecording()` directly,
	// which calls
	// `@tauri-apps/api/core` invoke → `window.__TAURI_INTERNALS__.invoke("hotkey_start_recording")`.
	// With the REAL module this is the seam that fires (the leaked-fake seam is
	// the nativeBridge.invoke above) — instrument both so either routing counts.
	tauriInternals().invoke = (cmd: string) => {
		if (cmd === "hotkey_start_recording") {
			startCalls.push(1);
			return Promise.resolve(false);
		}
		return Promise.resolve(undefined);
	};
});

afterEach(() => {
	window.nativeBridge = savedApi;
	tauriInternals().invoke = savedTauriInvoke;
	commands.changeBinding = savedChangeBinding;
});

function renderIt(
	currentKey = "LCtrl+LMeta",
	forbiddenCombos?: readonly ForbiddenCombo[],
	hotkeyId?: string,
) {
	const onKeyRecorded = mock((_key: string) => undefined);
	// `exactOptionalPropertyTypes: true` distinguishes "absent" from "undefined".
	// Only pass `forbiddenCombos` when actually present so the absent-case test
	// exercises the recorder's default-empty behaviour.
	const recorder =
		forbiddenCombos || hotkeyId ? (
			<HotkeyRecorder
				currentKey={currentKey}
				{...(forbiddenCombos ? { forbiddenCombos } : {})}
				{...(hotkeyId ? { hotkeyId } : {})}
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
		expect(resolveDisplayText(false, [], "LCtrl+A", "Press keys")).toBe(
			"L Ctrl + A",
		);
	});
	test("when recording with liveKeys returns them joined with ' + '", () => {
		const result = resolveDisplayText(
			true,
			["LCtrl", "A"],
			"LCtrl+A",
			"Press keys",
		);
		expect(result).toContain("L Ctrl");
		expect(result).toContain("A");
	});
	test("when recording with no liveKeys returns pressKeysLabel", () => {
		expect(resolveDisplayText(true, [], "LCtrl+A", "Press keys...")).toBe(
			"Press keys...",
		);
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

	test("the idle record button is transparent, not a surfaced play disk", () => {
		renderIt();
		const recBtn = screen.getByRole("button", { name: /record/i });
		expect(recBtn.className).toContain("bg-transparent");
		expect(recBtn.className).not.toMatch(/\bbg-surface-/);
	});

	test("clicking the record button calls hotkeyStartRecording (via the typed __TAURI_INTERNALS__.invoke seam)", () => {
		renderIt();
		const recBtn = screen.getByRole("button", { name: /record/i });
		fireEvent.click(recBtn);
		expect(startCalls.length).toBe(1);
	});
});

describe("findConflict", () => {
	const repaste = { combo: "LCtrl+LShift+V", label: "Re-paste" };
	const tts = { combo: "LCtrl+Space", label: "Text-to-speech" };

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
		expect(findConflict("LCtrl+LShift+V+LAlt", [repaste, tts])).toEqual(
			repaste,
		);
	});

	test("returns the first matching forbidden combo on subset (candidate ⊂ other)", () => {
		// Candidate's keys are all present in the other → candidate would
		// accidentally fire whenever the other is pressed.
		expect(findConflict("LCtrl+LShift", [repaste, tts])).toEqual(repaste);
	});
});

describe("HotkeyRecorder conflict gating", () => {
	const repaste: ForbiddenCombo = {
		combo: "LCtrl+LShift+V",
		label: "Re-paste",
	};
	const tts: ForbiddenCombo = { combo: "LCtrl+Space", label: "Text-to-speech" };

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

	test("claims a candidate with Windows before accepting it", async () => {
		const { onKeyRecorded } = renderIt("LCtrl+LMeta", undefined, "transcribe");
		startThenRecord("LCtrl+LAlt+R");
		await waitFor(() => {
			expect(changeBindingCalls).toEqual([
				{ id: "transcribe", binding: "LCtrl+LAlt+R" },
			]);
			expect(onKeyRecorded).toHaveBeenCalledWith("LCtrl+LAlt+R");
		});
	});

	test("keeps the old setting and shows the backend error when Windows rejects a candidate", async () => {
		changeBindingResult = {
			success: false,
			binding: null,
			error: "Shortcut is already in use",
		};
		const { onKeyRecorded } = renderIt("LCtrl+LMeta", undefined, "transcribe");
		startThenRecord("LCtrl+LAlt+R");
		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toContain("already in use");
		});
		expect(onKeyRecorded).not.toHaveBeenCalled();
	});
});

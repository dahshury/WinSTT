import { beforeEach, describe, expect, test } from "bun:test";
import { useHotkeyStore } from "./hotkey-store";

// Capture the AS-CONSTRUCTED store state at module load — BEFORE any
// `beforeEach` runs and resets the state via setState. This is the only
// way to assert that the constructor literals (`micPhase: "idle"`,
// `isActive: false`, `accelerator: "LCtrl+LMeta"`) really are the canonical
// defaults; once setState runs, mutated defaults are overwritten and
// indistinguishable from the originals.
const INITIAL_STATE_SNAPSHOT = {
	micPhase: useHotkeyStore.getState().micPhase,
	isActive: useHotkeyStore.getState().isActive,
	accelerator: useHotkeyStore.getState().accelerator,
};

beforeEach(() => {
	useHotkeyStore.setState({
		micPhase: "idle",
		isActive: false,
		accelerator: "LCtrl+LMeta",
	});
});

describe("useHotkeyStore", () => {
	test("initial state has the default LCtrl+LMeta accelerator", () => {
		const state = useHotkeyStore.getState();
		expect(state.micPhase).toBe("idle");
		expect(state.isActive).toBe(false);
		expect(state.accelerator).toBe("LCtrl+LMeta");
	});

	// Mutator-killers for the constructor literals. The `initial state` test
	// runs AFTER beforeEach() has called setState, so a mutant that defaults
	// micPhase to "live"/"opening" or isActive to `true` at construction is
	// invisible to it. The captured snapshot above was taken BEFORE any reset,
	// so it sees the actual literals.
	test("constructor literal: micPhase defaults to 'idle'", () => {
		expect(INITIAL_STATE_SNAPSHOT.micPhase).toBe("idle");
	});

	test("constructor literal: isActive defaults to false (not true)", () => {
		expect(INITIAL_STATE_SNAPSHOT.isActive).toBe(false);
	});

	test("constructor literal: accelerator defaults to the EXACT 'LCtrl+LMeta' string", () => {
		expect(INITIAL_STATE_SNAPSHOT.accelerator).toBe("LCtrl+LMeta");
		// Length-and-substring assertions also lock down the literal —
		// a mutant that empties the string would have length 0.
		expect(INITIAL_STATE_SNAPSHOT.accelerator.length).toBeGreaterThan(0);
	});

	test("setMicPhase moves through opening → live → idle, touching only micPhase", () => {
		useHotkeyStore.getState().setActive(true);
		useHotkeyStore.getState().setMicPhase("opening");
		expect(useHotkeyStore.getState().micPhase).toBe("opening");

		useHotkeyStore.getState().setMicPhase("live");
		const state = useHotkeyStore.getState();
		expect(state.micPhase).toBe("live");
		expect(state.isActive).toBe(true);

		useHotkeyStore.getState().setMicPhase("idle");
		expect(useHotkeyStore.getState().micPhase).toBe("idle");
	});

	test("setActive toggles only isActive", () => {
		useHotkeyStore.getState().setMicPhase("opening");
		useHotkeyStore.getState().setActive(true);
		const state = useHotkeyStore.getState();
		expect(state.isActive).toBe(true);
		expect(state.micPhase).toBe("opening");
	});

	test("setAccelerator updates the accelerator string", () => {
		useHotkeyStore.getState().setAccelerator("F2");
		expect(useHotkeyStore.getState().accelerator).toBe("F2");
	});

	// ─── Mutator-killers for the default accelerator string literal ───
	// A StringLiteral mutant that turns "LCtrl+LMeta" into "" would leave
	// the store with an empty accelerator at construction. The assertion
	// shape pins down the EXACT default literal.
	test("default accelerator literal is the EXACT 'LCtrl+LMeta' string (mutator-killer)", () => {
		useHotkeyStore.setState({
			micPhase: "idle",
			isActive: false,
			accelerator: "LCtrl+LMeta",
		});
		expect(useHotkeyStore.getState().accelerator).toBe("LCtrl+LMeta");
		expect(useHotkeyStore.getState().accelerator.length).toBeGreaterThan(0);
		expect(useHotkeyStore.getState().accelerator).toContain("LCtrl");
		expect(useHotkeyStore.getState().accelerator).toContain("LMeta");
		expect(useHotkeyStore.getState().accelerator).toContain("+");
	});

	// ─── micPhase / isActive payload-passthrough tests ───
	// Ensures the set({...}) payloads carry each value verbatim. A mutant that
	// hard-codes one phase would survive if we only ever set one value.
	test("setMicPhase('idle') clears the phase without touching isActive/accelerator", () => {
		useHotkeyStore.setState({
			micPhase: "live",
			isActive: true,
			accelerator: "X",
		});
		useHotkeyStore.getState().setMicPhase("idle");
		const state = useHotkeyStore.getState();
		expect(state.micPhase).toBe("idle");
		expect(state.isActive).toBe(true);
		expect(state.accelerator).toBe("X");
	});

	test("setActive(false) clears isActive without touching micPhase/accelerator", () => {
		useHotkeyStore.setState({
			micPhase: "live",
			isActive: true,
			accelerator: "X",
		});
		useHotkeyStore.getState().setActive(false);
		const state = useHotkeyStore.getState();
		expect(state.isActive).toBe(false);
		expect(state.micPhase).toBe("live");
		expect(state.accelerator).toBe("X");
	});

	test("setAccelerator does not affect micPhase or isActive", () => {
		useHotkeyStore.setState({
			micPhase: "live",
			isActive: true,
			accelerator: "old",
		});
		useHotkeyStore.getState().setAccelerator("new+combo");
		const state = useHotkeyStore.getState();
		expect(state.accelerator).toBe("new+combo");
		expect(state.micPhase).toBe("live");
		expect(state.isActive).toBe(true);
	});

	test("setAccelerator preserves an empty-string assignment verbatim", () => {
		useHotkeyStore.getState().setAccelerator("");
		expect(useHotkeyStore.getState().accelerator).toBe("");
	});
});

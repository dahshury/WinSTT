import { afterEach, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import fc from "fast-check";
import type { ModelSwapKind } from "@/shared/api/ipc-client";

// Install the faithful ipc-client fake so the swap-store init block doesn't blow up.
mock.module("@/shared/api/ipc-client", () => ipcClientMock());

const { useModelSwapStore } = await import("./model-swap-store");

const KINDS: ModelSwapKind[] = ["main", "realtime"];

interface SlotModel {
	active: string | null;
	from: string | null;
}
interface Model {
	main: SlotModel;
	realtime: SlotModel;
}

type Real = typeof useModelSwapStore;

function resetStore(): void {
	useModelSwapStore.setState({
		activeMain: null,
		activeRealtime: null,
		fromMain: null,
		fromRealtime: null,
	});
}

afterEach(resetStore);

function freshModel(): Model {
	return { main: { active: null, from: null }, realtime: { active: null, from: null } };
}

function slotOf(kind: ModelSwapKind, m: Model): SlotModel {
	return kind === "main" ? m.main : m.realtime;
}

function assertParity(m: Model, real: Real): void {
	const s = real.getState();
	if (s.activeMain !== m.main.active) {
		throw new Error(`activeMain mismatch: real=${s.activeMain} model=${m.main.active}`);
	}
	if (s.fromMain !== m.main.from) {
		throw new Error("fromMain mismatch");
	}
	if (s.activeRealtime !== m.realtime.active) {
		throw new Error("activeRealtime mismatch");
	}
	if (s.fromRealtime !== m.realtime.from) {
		throw new Error("fromRealtime mismatch");
	}
	// isSwapping invariant
	if (s.isSwapping("main") !== (m.main.active !== null)) {
		throw new Error("isSwapping(main) wrong");
	}
	if (s.isSwapping("realtime") !== (m.realtime.active !== null)) {
		throw new Error("isSwapping(realtime) wrong");
	}
}

class BeginSwapCmd implements fc.Command<Model, Real> {
	readonly kind: ModelSwapKind;
	readonly from: string;
	readonly to: string;
	constructor(kind: ModelSwapKind, from: string, to: string) {
		this.kind = kind;
		this.from = from;
		this.to = to;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		const otherKind: ModelSwapKind = this.kind === "main" ? "realtime" : "main";
		const otherSlotBefore = { ...slotOf(otherKind, m) };
		real.getState().beginSwap(this.kind, this.from, this.to);
		const slot = slotOf(this.kind, m);
		slot.active = this.to;
		slot.from = this.from;
		// orthogonality
		const otherAfter = slotOf(otherKind, m);
		if (otherAfter.active !== otherSlotBefore.active || otherAfter.from !== otherSlotBefore.from) {
			throw new Error("beginSwap mutated the other slot");
		}
		assertParity(m, real);
	}
	toString(): string {
		return `beginSwap(${this.kind},${this.from}→${this.to})`;
	}
}

class SetActiveCmd implements fc.Command<Model, Real> {
	readonly kind: ModelSwapKind;
	readonly name: string;
	constructor(kind: ModelSwapKind, name: string) {
		this.kind = kind;
		this.name = name;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		const otherKind: ModelSwapKind = this.kind === "main" ? "realtime" : "main";
		const otherSlotBefore = { ...slotOf(otherKind, m) };
		real.getState().setActive(this.kind, this.name);
		slotOf(this.kind, m).active = this.name;
		// setActive does NOT touch `from` — verify
		const otherAfter = slotOf(otherKind, m);
		if (otherAfter.active !== otherSlotBefore.active || otherAfter.from !== otherSlotBefore.from) {
			throw new Error("setActive mutated other slot");
		}
		assertParity(m, real);
	}
	toString(): string {
		return `setActive(${this.kind},${this.name})`;
	}
}

class ClearCmd implements fc.Command<Model, Real> {
	readonly kind: ModelSwapKind;
	constructor(kind: ModelSwapKind) {
		this.kind = kind;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		const otherKind: ModelSwapKind = this.kind === "main" ? "realtime" : "main";
		const otherSlotBefore = { ...slotOf(otherKind, m) };
		real.getState().clear(this.kind);
		const slot = slotOf(this.kind, m);
		slot.active = null;
		slot.from = null;
		const otherAfter = slotOf(otherKind, m);
		if (otherAfter.active !== otherSlotBefore.active || otherAfter.from !== otherSlotBefore.from) {
			throw new Error("clear mutated other slot");
		}
		assertParity(m, real);
		if (real.getState().isSwapping(this.kind)) {
			throw new Error("isSwapping still true after clear");
		}
	}
	toString(): string {
		return `clear(${this.kind})`;
	}
}

const kindArb = fc.constantFrom<ModelSwapKind>(...KINDS);
const nameArb = fc.string({ minLength: 1, maxLength: 16 });

const commandsArb = fc.commands(
	[
		fc.tuple(kindArb, nameArb, nameArb).map(([k, a, b]) => new BeginSwapCmd(k, a, b)),
		fc.tuple(kindArb, nameArb).map(([k, n]) => new SetActiveCmd(k, n)),
		kindArb.map((k) => new ClearCmd(k)),
	],
	{ maxCommands: 40 }
);

test("model-swap-store: arbitrary commands keep model-real parity and slot orthogonality", () => {
	fc.assert(
		fc.property(commandsArb, (cmds) => {
			resetStore();
			fc.modelRun(() => ({ model: freshModel(), real: useModelSwapStore }), cmds);
		}),
		{ numRuns: 80 }
	);
});

// Idempotency: clear(kind) is idempotent
test("model-swap-store: clear is idempotent per kind", () => {
	fc.assert(
		fc.property(kindArb, nameArb, nameArb, (kind, from, to) => {
			resetStore();
			useModelSwapStore.getState().beginSwap(kind, from, to);
			useModelSwapStore.getState().clear(kind);
			const s1 = { ...useModelSwapStore.getState() };
			useModelSwapStore.getState().clear(kind);
			const s2 = { ...useModelSwapStore.getState() };
			return (
				s1.activeMain === s2.activeMain &&
				s1.fromMain === s2.fromMain &&
				s1.activeRealtime === s2.activeRealtime &&
				s1.fromRealtime === s2.fromRealtime &&
				!useModelSwapStore.getState().isSwapping(kind)
			);
		}),
		{ numRuns: 50 }
	);
});

// Invariant: beginSwap followed by clear of same kind returns to clean per-kind slot.
test("model-swap-store: beginSwap + clear returns slot to initial state", () => {
	fc.assert(
		fc.property(kindArb, nameArb, nameArb, (kind, from, to) => {
			resetStore();
			useModelSwapStore.getState().beginSwap(kind, from, to);
			useModelSwapStore.getState().clear(kind);
			const s = useModelSwapStore.getState();
			if (kind === "main") {
				return s.activeMain === null && s.fromMain === null;
			}
			return s.activeRealtime === null && s.fromRealtime === null;
		}),
		{ numRuns: 50 }
	);
});

import { test } from "bun:test";
import fc from "fast-check";
import type { SpeakerSegment } from "./transcription";
import { useTranscriptionStore } from "./transcription-store";

const MAX_LIVE_ITEMS = 500;

interface Model {
	ephemeralText: string | null;
	isRecordingActive: boolean;
	isTranscribing: boolean;
	itemTexts: string[];
	lastItemHasSegments: boolean;
	realtime: string;
}

type Real = typeof useTranscriptionStore;

function snapshot(real: Real) {
	return real.getState();
}

function resetStore(): void {
	useTranscriptionStore.setState(
		{
			items: [],
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: false,
			isTranscribing: false,
			transcribingStartedAt: null,
		},
		false,
	);
}

function freshModel(): Model {
	return {
		itemTexts: [],
		realtime: "",
		ephemeralText: null,
		isRecordingActive: false,
		isTranscribing: false,
		lastItemHasSegments: false,
	};
}

class AddFinalCmd implements fc.Command<Model, Real> {
	readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		real.getState().addFinalSentence(this.text);
		m.itemTexts.push(this.text);
		if (m.itemTexts.length > MAX_LIVE_ITEMS) {
			m.itemTexts = m.itemTexts.slice(-MAX_LIVE_ITEMS);
		}
		m.realtime = "";
		m.isTranscribing = false;
		m.lastItemHasSegments = false;
		const state = snapshot(real);
		if (state.items.length > MAX_LIVE_ITEMS) {
			throw new Error(`items exceeded cap: ${state.items.length}`);
		}
		if (state.items.length !== m.itemTexts.length) {
			throw new Error(`length mismatch real=${state.items.length} model=${m.itemTexts.length}`);
		}
		if (state.currentRealtime !== "") {
			throw new Error("addFinalSentence did not clear currentRealtime");
		}
		if (state.isTranscribing) {
			throw new Error("addFinalSentence did not clear isTranscribing");
		}
		// last item text must match what we pushed
		const last = state.items.at(-1);
		if (!last || last.text !== this.text) {
			throw new Error("last item text mismatch");
		}
		if (last.type !== "final") {
			throw new Error("last item type not final");
		}
		if (typeof last.id !== "string" || last.id.length === 0) {
			throw new Error("last item id invalid");
		}
	}
	toString(): string {
		return `addFinal(${JSON.stringify(this.text)})`;
	}
}

class SetRealtimeCmd implements fc.Command<Model, Real> {
	readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		real.getState().setRealtimeText(this.text);
		m.realtime = this.text;
		if (snapshot(real).currentRealtime !== this.text) {
			throw new Error("setRealtimeText did not persist");
		}
	}
	toString(): string {
		return `setRealtime(${JSON.stringify(this.text)})`;
	}
}

class SetRecordingActiveCmd implements fc.Command<Model, Real> {
	readonly active: boolean;
	constructor(active: boolean) {
		this.active = active;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		real.getState().setRecordingActive(this.active);
		m.isRecordingActive = this.active;
		if (snapshot(real).isRecordingActive !== this.active) {
			throw new Error("setRecordingActive did not persist");
		}
	}
	toString(): string {
		return `setRecordingActive(${this.active})`;
	}
}

class SetTranscribingCmd implements fc.Command<Model, Real> {
	readonly active: boolean;
	constructor(active: boolean) {
		this.active = active;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		real.getState().setTranscribing(this.active);
		m.isTranscribing = this.active;
		const state = snapshot(real);
		if (state.isTranscribing !== this.active) {
			throw new Error("setTranscribing did not persist");
		}
		if (this.active && typeof state.transcribingStartedAt !== "number") {
			throw new Error("setTranscribing(true) did not set a timestamp");
		}
		if (!this.active && state.transcribingStartedAt !== null) {
			throw new Error("setTranscribing(false) did not clear timestamp");
		}
	}
	toString(): string {
		return `setTranscribing(${this.active})`;
	}
}

class ShowEphemeralCmd implements fc.Command<Model, Real> {
	readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		real.getState().showEphemeral(this.text);
		m.ephemeralText = this.text;
		const eph = snapshot(real).ephemeral;
		if (!eph || eph.text !== this.text || typeof eph.timestamp !== "number") {
			throw new Error("showEphemeral failed invariants");
		}
	}
	toString(): string {
		return `showEphemeral(${JSON.stringify(this.text)})`;
	}
}

class ClearEphemeralCmd implements fc.Command<Model, Real> {
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		real.getState().clearEphemeral();
		m.ephemeralText = null;
		if (snapshot(real).ephemeral !== null) {
			throw new Error("clearEphemeral did not null out");
		}
	}
	toString(): string {
		return "clearEphemeral()";
	}
}

class ClearAllCmd implements fc.Command<Model, Real> {
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		real.getState().clearAll();
		m.itemTexts = [];
		m.realtime = "";
		m.ephemeralText = null;
		m.isRecordingActive = false;
		m.isTranscribing = false;
		m.lastItemHasSegments = false;
		const s = snapshot(real);
		if (s.items.length !== 0) {
			throw new Error("clearAll did not empty items");
		}
		if (s.currentRealtime !== "") {
			throw new Error("clearAll did not clear realtime");
		}
		if (s.ephemeral !== null) {
			throw new Error("clearAll did not clear ephemeral");
		}
		if (s.isRecordingActive !== false) {
			throw new Error("clearAll did not clear isRecordingActive");
		}
		if (s.isTranscribing !== false || s.transcribingStartedAt !== null) {
			throw new Error("clearAll did not clear transcribing state");
		}
	}
	toString(): string {
		return "clearAll()";
	}
}

class AttachSegmentsCmd implements fc.Command<Model, Real> {
	readonly segments: SpeakerSegment[];
	constructor(segments: SpeakerSegment[]) {
		this.segments = segments;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		const before = snapshot(real).items;
		real.getState().attachSpeakerSegments(this.segments);
		const after = snapshot(real).items;
		if (m.itemTexts.length === 0) {
			// empty feed → no-op; reference must be preserved
			if (after !== before) {
				throw new Error("attachSpeakerSegments mutated empty feed");
			}
		} else {
			const last = after.at(-1);
			if (!last || JSON.stringify(last.speakerSegments) !== JSON.stringify(this.segments)) {
				throw new Error("segments not attached to last item");
			}
			if (after.length !== m.itemTexts.length) {
				throw new Error("attachSpeakerSegments changed item count");
			}
			m.lastItemHasSegments = true;
		}
	}
	toString(): string {
		return `attachSegments(n=${this.segments.length})`;
	}
}

const segmentArb: fc.Arbitrary<SpeakerSegment> = fc.record({
	start: fc.double({ min: 0, max: 100, noNaN: true }),
	end: fc.double({ min: 0, max: 100, noNaN: true }),
	speaker: fc.integer({ min: 0, max: 8 }),
});

const commandsArb = fc.commands(
	[
		fc.string({ maxLength: 32 }).map((s) => new AddFinalCmd(s)),
		fc.string({ maxLength: 16 }).map((s) => new SetRealtimeCmd(s)),
		fc.boolean().map((b) => new SetRecordingActiveCmd(b)),
		fc.boolean().map((b) => new SetTranscribingCmd(b)),
		fc.string({ maxLength: 16 }).map((s) => new ShowEphemeralCmd(s)),
		fc.constant(new ClearEphemeralCmd()),
		fc.constant(new ClearAllCmd()),
		fc.array(segmentArb, { maxLength: 5 }).map((segs) => new AttachSegmentsCmd(segs)),
	],
	{ maxCommands: 40 },
);

test("transcription-store: arbitrary command sequence preserves invariants", () => {
	fc.assert(
		fc.property(commandsArb, (cmds) => {
			resetStore();
			const model: Model = freshModel();
			const real: Real = useTranscriptionStore;
			fc.modelRun(() => ({ model, real }), cmds);
		}),
		{ numRuns: 80 },
	);
});

// Idempotency property: clearAll twice == clearAll once
test("transcription-store: clearAll is idempotent (twice == once)", () => {
	fc.assert(
		fc.property(
			fc.array(fc.string({ maxLength: 16 }), { maxLength: 20 }),
			fc.string({ maxLength: 16 }),
			(sentences, ephem) => {
				resetStore();
				for (const s of sentences) {
					useTranscriptionStore.getState().addFinalSentence(s);
				}
				useTranscriptionStore.getState().showEphemeral(ephem);
				useTranscriptionStore.getState().setRecordingActive(true);
				useTranscriptionStore.getState().setTranscribing(true);
				useTranscriptionStore.getState().clearAll();
				const after1 = useTranscriptionStore.getState();
				useTranscriptionStore.getState().clearAll();
				const after2 = useTranscriptionStore.getState();
				return (
					after1.items.length === 0 &&
					after2.items.length === 0 &&
					after1.currentRealtime === after2.currentRealtime &&
					after1.ephemeral === after2.ephemeral &&
					after1.isRecordingActive === after2.isRecordingActive &&
					after1.isTranscribing === after2.isTranscribing &&
					after1.transcribingStartedAt === after2.transcribingStartedAt
				);
			},
		),
		{ numRuns: 50 },
	);
});

// Bound property: items.length never exceeds MAX_LIVE_ITEMS regardless of how many we add
test("transcription-store: items count never exceeds MAX_LIVE_ITEMS", () => {
	fc.assert(
		fc.property(fc.integer({ min: 0, max: 1200 }), (count) => {
			resetStore();
			for (let i = 0; i < count; i++) {
				useTranscriptionStore.getState().addFinalSentence(`s-${i}`);
			}
			const len = useTranscriptionStore.getState().items.length;
			return len <= MAX_LIVE_ITEMS && len === Math.min(count, MAX_LIVE_ITEMS);
		}),
		{ numRuns: 30 },
	);
});

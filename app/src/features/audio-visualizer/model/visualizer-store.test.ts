import { beforeEach, describe, expect, test } from "bun:test";
import { useVisualizerStore } from "./visualizer-store";

// Capture the AS-CONSTRUCTED store state at module load — BEFORE any
// `beforeEach` runs and resets the state via setState. This is the only
// way to assert that the literals on L30 (`isRecording: false`) and L31
// (`isSpeaking: false`) really are `false` by default; once setState
// runs, the mutant's `true` default is overwritten and indistinguishable
// from the original.
const INITIAL_STATE_SNAPSHOT = {
	isRecording: useVisualizerStore.getState().isRecording,
	isSpeaking: useVisualizerStore.getState().isSpeaking,
	audioLevel: useVisualizerStore.getState().audioLevel,
	sentencePulse: useVisualizerStore.getState().sentencePulse,
};

beforeEach(() => {
	useVisualizerStore.setState({
		isRecording: false,
		isSpeaking: false,
		audioLevel: 0,
		sentencePulse: 0,
	});
});

describe("useVisualizerStore", () => {
	test("initial state", () => {
		const state = useVisualizerStore.getState();
		expect(state.isRecording).toBe(false);
		expect(state.isSpeaking).toBe(false);
		expect(state.audioLevel).toBe(0);
		expect(state.sentencePulse).toBe(0);
	});

	// Mutator-killer for L30 (`isRecording: false`) and L31 (`isSpeaking:
	// false`) booleans. The `initial state` test above runs AFTER
	// beforeEach() has called setState — so a mutant that defaults
	// these to `true` at construction is invisible to it. The captured
	// snapshot above was taken BEFORE any reset, so it sees the actual
	// constructor literal.
	test("constructor literal: isRecording defaults to false (not true)", () => {
		expect(INITIAL_STATE_SNAPSHOT.isRecording).toBe(false);
	});

	test("constructor literal: isSpeaking defaults to false (not true)", () => {
		expect(INITIAL_STATE_SNAPSHOT.isSpeaking).toBe(false);
	});

	test("constructor literal: audioLevel defaults to 0", () => {
		expect(INITIAL_STATE_SNAPSHOT.audioLevel).toBe(0);
	});

	test("constructor literal: sentencePulse defaults to 0", () => {
		expect(INITIAL_STATE_SNAPSHOT.sentencePulse).toBe(0);
	});

	test("setRecording toggles isRecording without affecting other fields", () => {
		useVisualizerStore.getState().setAudioLevel(0.5);
		useVisualizerStore.getState().setRecording(true);
		expect(useVisualizerStore.getState().isRecording).toBe(true);
		expect(useVisualizerStore.getState().audioLevel).toBe(0.5);
	});

	test("setSpeaking, setAudioLevel, setSentencePulse update only their fields", () => {
		useVisualizerStore.getState().setSpeaking(true);
		useVisualizerStore.getState().setAudioLevel(0.75);
		useVisualizerStore.getState().setSentencePulse(0.3);
		const state = useVisualizerStore.getState();
		expect(state.isSpeaking).toBe(true);
		expect(state.audioLevel).toBe(0.75);
		expect(state.sentencePulse).toBe(0.3);
		expect(state.isRecording).toBe(false);
	});

	// ─── recordingStarted contract: 3-field atomic update ───
	// Locks in the L35 ObjectLiteral mutator (replacing the entire
	// `set({...})` payload with `{}`) and each of the three boolean/number
	// literals in the payload.
	test("recordingStarted sets isRecording=true AND zeros audioLevel + sentencePulse atomically", () => {
		// Pre-seed non-zero / wrong values so we can prove they were reset.
		useVisualizerStore.setState({
			isRecording: false,
			isSpeaking: true, // not touched by recordingStarted — should stay true
			audioLevel: 0.5,
			sentencePulse: 0.7,
		});
		useVisualizerStore.getState().recordingStarted();
		const state = useVisualizerStore.getState();
		expect(state.isRecording).toBe(true);
		expect(state.audioLevel).toBe(0);
		expect(state.sentencePulse).toBe(0);
		// isSpeaking is NOT touched by recordingStarted — proves the
		// reducer didn't accidentally clear it (an empty-object mutant
		// would leave it at `true`, but our true=>true assertion guards
		// against an over-aggressive reducer that also sets isSpeaking).
		expect(state.isSpeaking).toBe(true);
	});

	test("recordingStarted from a clean state still sets isRecording=true", () => {
		// A clean-state guard. If the L35 ObjectLiteral mutant turns the
		// payload into `{}`, isRecording would remain false.
		useVisualizerStore.setState({
			isRecording: false,
			isSpeaking: false,
			audioLevel: 0,
			sentencePulse: 0,
		});
		useVisualizerStore.getState().recordingStarted();
		expect(useVisualizerStore.getState().isRecording).toBe(true);
	});

	// ─── recordingStopped contract: clears flags AND zeros level/pulse atomically ───
	// This is the truth-at-data-layer invariant — hidden windows must show
	// audioLevel=0 on next paint without depending on an rAF fade that pauses
	// while the renderer is backgrounded.
	test("recordingStopped clears flags AND zeros audioLevel + sentencePulse", () => {
		useVisualizerStore.setState({
			isRecording: true,
			isSpeaking: true,
			audioLevel: 0.5,
			sentencePulse: 0.5,
		});
		useVisualizerStore.getState().recordingStopped();
		const state = useVisualizerStore.getState();
		expect(state.isRecording).toBe(false);
		expect(state.isSpeaking).toBe(false);
		expect(state.audioLevel).toBe(0);
		expect(state.sentencePulse).toBe(0);
	});

	test("recordingStopped is a no-op for already-cleared state", () => {
		useVisualizerStore.setState({
			isRecording: false,
			isSpeaking: false,
			audioLevel: 0,
			sentencePulse: 0,
		});
		useVisualizerStore.getState().recordingStopped();
		const state = useVisualizerStore.getState();
		expect(state.isRecording).toBe(false);
		expect(state.isSpeaking).toBe(false);
		expect(state.audioLevel).toBe(0);
		expect(state.sentencePulse).toBe(0);
	});

	// ─── Round-trip: started → stopped sequence ───
	test("started → stopped leaves all visualizer state at ground truth (zero)", () => {
		const s = useVisualizerStore.getState();
		s.recordingStarted();
		s.setSpeaking(true);
		s.setAudioLevel(0.9);
		s.setSentencePulse(0.6);
		s.recordingStopped();
		const final = useVisualizerStore.getState();
		expect(final.isRecording).toBe(false);
		expect(final.isSpeaking).toBe(false);
		expect(final.audioLevel).toBe(0);
		expect(final.sentencePulse).toBe(0);
	});

	// ─── setRecording / setSpeaking explicit boolean tests ───
	// Locks in the L37-39 set({...}) shapes — a mutant that swaps the
	// passed value for `false` would leak through if we only ever pass
	// `true`.
	test("setRecording(false) clears isRecording", () => {
		useVisualizerStore.setState({
			isRecording: true,
			isSpeaking: false,
			audioLevel: 0,
			sentencePulse: 0,
		});
		useVisualizerStore.getState().setRecording(false);
		expect(useVisualizerStore.getState().isRecording).toBe(false);
	});

	test("setSpeaking(false) clears isSpeaking", () => {
		useVisualizerStore.setState({
			isRecording: false,
			isSpeaking: true,
			audioLevel: 0,
			sentencePulse: 0,
		});
		useVisualizerStore.getState().setSpeaking(false);
		expect(useVisualizerStore.getState().isSpeaking).toBe(false);
	});

	test("setAudioLevel accepts and persists exact numeric inputs (boundary checks)", () => {
		useVisualizerStore.getState().setAudioLevel(0);
		expect(useVisualizerStore.getState().audioLevel).toBe(0);
		useVisualizerStore.getState().setAudioLevel(1);
		expect(useVisualizerStore.getState().audioLevel).toBe(1);
		useVisualizerStore.getState().setAudioLevel(0.123);
		expect(useVisualizerStore.getState().audioLevel).toBe(0.123);
	});

	test("setSentencePulse accepts and persists exact numeric inputs", () => {
		useVisualizerStore.getState().setSentencePulse(0);
		expect(useVisualizerStore.getState().sentencePulse).toBe(0);
		useVisualizerStore.getState().setSentencePulse(1);
		expect(useVisualizerStore.getState().sentencePulse).toBe(1);
	});
});

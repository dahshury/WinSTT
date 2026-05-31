import { describe, expect, test } from "bun:test";
import { computeIslandSize } from "./OverlayPage";

// `computeIslandSize` is the WIDTH state-machine that maps the renderer's
// live state (recording armed, VAD speaking, LLM thinking, captioned text)
// onto a DynamicIsland size preset. Height is intrinsic in dynamic-island
// mode (the shell uses `fitContent`), so there's no per-line-count branch
// here — `long` covers any amount of text and the shell grows organically.

describe("computeIslandSize", () => {
	test("collapses to empty when nothing is happening", () => {
		expect(
			computeIslandSize({
				isRecordingActive: false,
				isSpeaking: false,
				isThinking: false,
				hasShownText: false,
			})
		).toBe("empty");
	});

	test("thinking with NO captioned text stays compact (main-model-only path)", () => {
		// isRecordingActive has already flipped off by the time the LLM-thinking
		// callback fires; the thinking branch still resolves first so the island
		// doesn't empty out between the recording end and the indicator showing.
		// But with no captioned text the indicator is a chip-sized rotating-word
		// readout — the island keeps its compact recording footprint and swaps
		// the visualizer for the indicator instead of ballooning to `long`.
		expect(
			computeIslandSize({
				isRecordingActive: false,
				isSpeaking: false,
				isThinking: true,
				hasShownText: false,
			})
		).toBe("compactMedium");
	});

	test("thinking WITH captioned text widens to long (text needs the room)", () => {
		// When the realtime model streamed words into the pill, the thinking
		// indicator shares the surface with wrapped captions — keep the wide
		// `long` width so both read legibly.
		expect(
			computeIslandSize({
				isRecordingActive: false,
				isSpeaking: false,
				isThinking: true,
				hasShownText: true,
			})
		).toBe("long");
	});

	test("recording armed with no speech yet → compact", () => {
		expect(
			computeIslandSize({
				isRecordingActive: true,
				isSpeaking: false,
				isThinking: false,
				hasShownText: false,
			})
		).toBe("compact");
	});

	test("recording armed, VAD speaking, no text → compactMedium (grows on speech)", () => {
		expect(
			computeIslandSize({
				isRecordingActive: true,
				isSpeaking: true,
				isThinking: false,
				hasShownText: false,
			})
		).toBe("compactMedium");
	});

	test("captioned recording maps to long regardless of text length (height is intrinsic)", () => {
		// Whether one word or a paragraph, width stays at `long` — the
		// shell's `fitContent` lets every wrapped line extend the height by
		// exactly one line. No more discrete `long → tall` jump at a chars
		// threshold.
		expect(
			computeIslandSize({
				isRecordingActive: true,
				isSpeaking: true,
				isThinking: false,
				hasShownText: true,
			})
		).toBe("long");
	});

	test("hasShownText=false keeps the compact path (in-pill captions off)", () => {
		// `hasShownText` already folds in liveTranscriptionDisplay — if the
		// user has captions off, even a long realtime stream stays a
		// compact / compactMedium visualizer instead of widening to `long`.
		expect(
			computeIslandSize({
				isRecordingActive: true,
				isSpeaking: true,
				isThinking: false,
				hasShownText: false,
			})
		).toBe("compactMedium");
	});

	test("thinking outranks an actively-recording captioned state", () => {
		// LLM thinking can in principle overlap a still-active recording in
		// degenerate timings; the thinking branch wins regardless.
		expect(
			computeIslandSize({
				isRecordingActive: true,
				isSpeaking: true,
				isThinking: true,
				hasShownText: true,
			})
		).toBe("long");
	});
});

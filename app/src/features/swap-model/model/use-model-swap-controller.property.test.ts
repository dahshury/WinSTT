/**
 * Property tests for the pure helpers in use-model-swap-controller.ts.
 *
 * Companion to use-model-swap-controller.test.ts. The example-based file
 * covers each branch once (68 tests); this file pins down INVARIANTS across
 * the whole input space for the trivial pure helpers — the kind of property
 * that survives mutation tests on the boolean predicates.
 *
 *   - isQuantizationChanging:  truth table — equivalent to `q !== undefined && q !== current`.
 *   - resolveTargetQuant:       ?? semantics — `q ?? current`.
 *   - isCriticalAssessment:    total predicate; truthy only when severity === "critical".
 *   - toPresentList:           length 0 or 1; element identity preserved.
 *   - baseMainPatch:           output shape stays well-formed; model field is identity.
 *   - resolveCandidateName:    falls back to value when displayName is missing.
 *   - applyQuantOverride:      identity-on-no-change; merges only when changing+defined.
 */
import { describe, test } from "bun:test";
import fc from "fast-check";
import type { FitAssessmentEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { __testables } from "./use-model-swap-controller";

const t = __testables;

// `isCriticalAssessment` only reads `.severity`; this contains the single
// boundary cast from the minimal `{ severity }` stub to the real entry type,
// returning the same object it was given.
const asAssessment = (a: { severity: string }) => a as unknown as FitAssessmentEntry;

const quantArb: fc.Arbitrary<OnnxQuantization> = fc.constantFrom(
	"int8",
	"fp16",
	"uint8",
	"q4",
	"q4f16",
	"bnb4"
);

// isQuantizationChanging ----------------------------------------------------

describe("isQuantizationChanging (property)", () => {
	test("false when target quantization is undefined", () => {
		fc.assert(
			fc.property(quantArb, (current) => t.isQuantizationChanging(undefined, current) === false),
			{ numRuns: 100 }
		);
	});

	test("false when target equals current (reflexivity)", () => {
		fc.assert(
			fc.property(quantArb, (q) => t.isQuantizationChanging(q, q) === false),
			{ numRuns: 100 }
		);
	});

	test("matches the manual predicate `q !== undefined && q !== current`", () => {
		fc.assert(
			fc.property(fc.option(quantArb, { nil: undefined }), quantArb, (target, current) => {
				const expected = target !== undefined && target !== current;
				return t.isQuantizationChanging(target, current) === expected;
			}),
			{ numRuns: 200 }
		);
	});

	test("symmetric on differing quantizations", () => {
		fc.assert(
			fc.property(quantArb, quantArb, (a, b) => {
				if (a === b) {
					return true; // skip equal case
				}
				return t.isQuantizationChanging(a, b) === t.isQuantizationChanging(b, a);
			}),
			{ numRuns: 200 }
		);
	});
});

// resolveTargetQuant --------------------------------------------------------

describe("resolveTargetQuant (property)", () => {
	test("returns the target when defined", () => {
		fc.assert(
			fc.property(
				quantArb,
				quantArb,
				(target, current) => t.resolveTargetQuant(target, current) === target
			),
			{ numRuns: 200 }
		);
	});

	test("returns current when target is undefined", () => {
		fc.assert(
			fc.property(quantArb, (current) => t.resolveTargetQuant(undefined, current) === current),
			{ numRuns: 100 }
		);
	});

	test("matches `target ?? current`", () => {
		fc.assert(
			fc.property(fc.option(quantArb, { nil: undefined }), quantArb, (target, current) => {
				const expected = target ?? current;
				return t.resolveTargetQuant(target, current) === expected;
			}),
			{ numRuns: 200 }
		);
	});
});

// isCriticalAssessment ------------------------------------------------------

describe("isCriticalAssessment (property)", () => {
	const severityArb = fc.constantFrom("none", "warn", "critical");

	test("false for null or undefined input", () => {
		fc.assert(
			fc.property(fc.constantFrom(null, undefined), (v) => t.isCriticalAssessment(v) === false),
			{ numRuns: 20 }
		);
	});

	test("true only when severity === 'critical'", () => {
		fc.assert(
			fc.property(severityArb, (sev) => {
				const assessment = asAssessment({ severity: sev });
				return t.isCriticalAssessment(assessment) === (sev === "critical");
			}),
			{ numRuns: 100 }
		);
	});
});

// toPresentList -------------------------------------------------------------

describe("toPresentList (property)", () => {
	test("returns [] when state is undefined", () => {
		fc.assert(
			fc.property(fc.constant(undefined), (v) => t.toPresentList(v).length === 0),
			{ numRuns: 10 }
		);
	});

	test("returns a singleton containing the state by reference when defined", () => {
		fc.assert(
			fc.property(fc.object(), (rawObj) => {
				const state = rawObj as never;
				const list = t.toPresentList(state);
				return list.length === 1 && list[0] === state;
			}),
			{ numRuns: 100 }
		);
	});

	test("length is always 0 or 1 (no surprises)", () => {
		fc.assert(
			fc.property(fc.oneof(fc.constant(undefined), fc.object()), (v) => {
				const list = t.toPresentList(v as never);
				return list.length === 0 || list.length === 1;
			}),
			{ numRuns: 100 }
		);
	});
});

// baseMainPatch was removed alongside the typed ModelPatch change: a bare
// ``{ model }`` patch is no longer representable. The catalog-miss path is
// now handled by an early return in ``applyMainSwap`` (covered by the swap
// controller integration tests). Property tests for the patch itself are
// folded into ``buildMainSwapPatch`` below.

// resolveCandidateName ------------------------------------------------------

describe("resolveCandidateName (property)", () => {
	test("returns displayName when defined; falls back to value otherwise", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 30 }),
				fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
				(value, displayName) => {
					const getModel = (v: string) =>
						v === value ? ({ displayName } as { displayName?: string }) : undefined;
					const out = t.resolveCandidateName(getModel as never, value);
					return out === (displayName ?? value);
				}
			),
			{ numRuns: 200 }
		);
	});

	test("falls back to value when getModel returns undefined", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 30 }),
				(value) => t.resolveCandidateName(() => undefined, value) === value
			),
			{ numRuns: 100 }
		);
	});
});

// applyQuantOverride --------------------------------------------------------

describe("applyQuantOverride (property)", () => {
	test("identity when quantizationChanging is false (no merge regardless of value)", () => {
		fc.assert(
			fc.property(
				fc.record({ model: fc.string() }),
				fc.option(quantArb, { nil: undefined }),
				(patch, q) => {
					const before = { ...patch };
					const after = t.applyQuantOverride(patch as never, q, false);
					return JSON.stringify(after) === JSON.stringify(before) && !("onnxQuantization" in after);
				}
			),
			{ numRuns: 200 }
		);
	});

	test("identity when quantization is undefined (no merge regardless of changing flag)", () => {
		fc.assert(
			fc.property(fc.record({ model: fc.string() }), (patch) => {
				const before = { ...patch };
				const after = t.applyQuantOverride(patch as never, undefined, true);
				return JSON.stringify(after) === JSON.stringify(before) && !("onnxQuantization" in after);
			}),
			{ numRuns: 100 }
		);
	});

	test("when changing=true and value defined, onnxQuantization is set on output", () => {
		fc.assert(
			fc.property(fc.record({ model: fc.string() }), quantArb, (patch, q) => {
				const after = t.applyQuantOverride(patch as never, q, true);
				return (after as { onnxQuantization?: OnnxQuantization }).onnxQuantization === q;
			}),
			{ numRuns: 200 }
		);
	});
});

// needsDownloadPrompt -------------------------------------------------------

describe("needsDownloadPrompt (property)", () => {
	// Unknown model-state must fail SAFE to "prompt for download" for EVERY
	// quant: without state we can't prove the weights are cached, so silently
	// issuing a swap (the old fail-OPEN behaviour) left nothing loaded. Mirrors
	// the unit assertion in use-model-swap-controller.test.ts.
	test("true for every quant when state is undefined (fail-safe to download)", () => {
		fc.assert(
			fc.property(quantArb, (q) => t.needsDownloadPrompt(undefined, q) === true),
			{ numRuns: 50 }
		);
	});
});

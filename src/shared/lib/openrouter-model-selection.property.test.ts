import { describe, test } from "bun:test";
import fc from "fast-check";
import { createModelSelection, parseModelSelection } from "./openrouter-model-selection";

// Model IDs in the wild are slugs like "openai/gpt-4o". For round-trip
// guarantees, the model id must NOT contain '@' (which is the delimiter the
// encoder uses to split modelId from providerSlug) — the encoder does not
// escape '@' in the modelId, so an id like "a@b" would re-parse as
// modelId="a", providerSlug="b". This is documented at the call site:
// `createModelSelection` is the inverse of `parseModelSelection` only over
// the domain of '@'-free model ids.
const modelIdArb = fc
	.string({ minLength: 1, maxLength: 40 })
	.filter((s) => !(s.includes("@") || s.includes("\0")));
const providerSlugArb = fc
	.string({ minLength: 1, maxLength: 20 })
	.filter((s) => !(s.includes("@") || s.includes("\0")));

describe("createModelSelection ↔ parseModelSelection round-trip", () => {
	test("create(modelId, provider) round-trips back to the same (modelId, provider)", () => {
		fc.assert(
			fc.property(modelIdArb, providerSlugArb, (modelId, providerSlug) => {
				const encoded = createModelSelection(modelId, providerSlug);
				const decoded = parseModelSelection(encoded);
				return decoded.modelId === modelId && decoded.providerSlug === providerSlug;
			}),
			{ numRuns: 300 }
		);
	});

	test("create(modelId) without provider round-trips (modelId, providerSlug undefined)", () => {
		fc.assert(
			fc.property(modelIdArb, (modelId) => {
				const encoded = createModelSelection(modelId);
				const decoded = parseModelSelection(encoded);
				return decoded.modelId === modelId && decoded.providerSlug === undefined;
			}),
			{ numRuns: 300 }
		);
	});

	test("empty modelId always encodes to empty string regardless of provider", () => {
		fc.assert(
			fc.property(
				fc.option(providerSlugArb, { nil: undefined }),
				(slug) => createModelSelection("", slug) === ""
			),
			{ numRuns: 200 }
		);
	});

	test("parseModelSelection is deterministic — same input ⇒ same output", () => {
		fc.assert(
			fc.property(fc.string(), (input) => {
				const a = parseModelSelection(input);
				const b = parseModelSelection(input);
				return a.modelId === b.modelId && a.providerSlug === b.providerSlug;
			}),
			{ numRuns: 300 }
		);
	});

	test("parseModelSelection never throws on arbitrary strings", () => {
		fc.assert(
			fc.property(fc.string(), (input) => {
				try {
					const result = parseModelSelection(input);
					return typeof result.modelId === "string";
				} catch {
					return false;
				}
			}),
			{ numRuns: 300 }
		);
	});
});

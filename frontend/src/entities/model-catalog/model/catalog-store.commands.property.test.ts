import { afterEach, beforeEach, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import fc from "fast-check";

// Stub ipc-client so module-load init doesn't blow up — catalog-store.test.ts
// uses the same pattern.
mock.module("@/shared/api/ipc-client", () => ipcClientMock());

const originalElectronApi = window.electronAPI;

const { useCatalogStore } = await import("./catalog-store");

const BACKENDS = ["faster_whisper", "onnx_asr"] as const;
const FAMILIES = [
	"whisper",
	"lite-whisper",
	"nemo",
	"gigaam",
	"kaldi",
	"t-one",
	"moonshine",
	"cohere",
	"granite",
] as const;

interface RawValid {
	available_quantizations?: string[];
	backend: (typeof BACKENDS)[number];
	description: string;
	display_name: string;
	family: (typeof FAMILIES)[number];
	id: string;
	languages: string[];
	onnx_model_name: string | null;
	size_label: string;
	supports_language_detection: boolean;
	supports_realtime: boolean;
}

interface Model {
	// the set of *expected-valid* ids that should appear after setModels
	expectedValidIds: string[];
}

type Real = typeof useCatalogStore;

function resetStore(): void {
	useCatalogStore.setState({ models: [], isLoaded: false });
}

beforeEach(() => {
	window.electronAPI = {
		getPathForFile: () => "",
		send: () => undefined,
		invoke: async () => undefined,
		secureInvoke: async () => undefined,
		on: () => () => undefined,
	};
});

afterEach(() => {
	window.electronAPI = originalElectronApi;
});

function freshModel(): Model {
	return { expectedValidIds: [] };
}

function assertInvariants(real: Real, m: Model): void {
	const s = real.getState();
	// 1. Loaded flag is true after any setModels.
	if (!s.isLoaded) {
		throw new Error("isLoaded should be true after setModels");
	}
	// 2. Every model id is unique vs expected — actually setModels does NOT
	//    dedupe; multiple valid items with same id all show up. We only assert
	//    that the count equals what we expected.
	if (s.models.length !== m.expectedValidIds.length) {
		throw new Error(`length mismatch real=${s.models.length} model=${m.expectedValidIds.length}`);
	}
	// 3. Each model has all required fields populated (mapper guarantees this).
	for (const mdl of s.models) {
		if (typeof mdl.id !== "string") {
			throw new Error("id missing");
		}
		if (typeof mdl.displayName !== "string") {
			throw new Error("displayName missing");
		}
		if (!BACKENDS.includes(mdl.backend)) {
			throw new Error("backend out of enum");
		}
		if (!FAMILIES.includes(mdl.family)) {
			throw new Error("family out of enum");
		}
		if (!Array.isArray(mdl.languages)) {
			throw new Error("languages not array");
		}
		if (!Array.isArray(mdl.availableQuantizations)) {
			throw new Error("availableQuantizations not array");
		}
		if (typeof mdl.supportsLanguageDetection !== "boolean") {
			throw new Error("supportsLanguageDetection not boolean");
		}
	}
	// 4. getFamilies returns a deduplicated set.
	const families = s.getFamilies();
	if (new Set(families).size !== families.length) {
		throw new Error("getFamilies has duplicates");
	}
	for (const f of families) {
		if (!s.models.some((mdl) => mdl.family === f)) {
			throw new Error("getFamilies returned a family with no model");
		}
	}
}

class SetModelsCmd implements fc.Command<Model, Real> {
	readonly validRaw: RawValid[];
	readonly invalidRaw: unknown[];
	constructor(validRaw: RawValid[], invalidRaw: unknown[]) {
		this.validRaw = validRaw;
		this.invalidRaw = invalidRaw;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		const combined: unknown[] = [...this.validRaw, ...this.invalidRaw];
		// Shuffle deterministically based on length to mix valids and invalids.
		const shuffled = combined.slice();
		for (let i = 0; i < shuffled.length; i++) {
			const j = (i * 7 + 3) % shuffled.length;
			const tmp = shuffled[i];
			shuffled[i] = shuffled[j];
			shuffled[j] = tmp;
		}
		real.getState().setModels(shuffled);
		m.expectedValidIds = this.validRaw.map((r) => r.id);
		assertInvariants(real, m);
		// getModel selector: every valid id must round-trip.
		for (const v of this.validRaw) {
			const found = real.getState().getModel(v.id);
			if (found === undefined) {
				throw new Error(`getModel(${v.id}) returned undefined`);
			}
			if (found.id !== v.id) {
				throw new Error("getModel returned wrong model");
			}
		}
	}
	toString(): string {
		return `setModels(valid=${this.validRaw.length},invalid=${this.invalidRaw.length})`;
	}
}

class GetModelMissCmd implements fc.Command<Model, Real> {
	readonly id: string;
	constructor(id: string) {
		this.id = id;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		if (m.expectedValidIds.includes(this.id)) {
			return; // skip; only assert misses
		}
		const found = real.getState().getModel(this.id);
		if (found !== undefined) {
			throw new Error(`getModel(${this.id}) returned hit for absent id`);
		}
	}
	toString(): string {
		return `getModel(${this.id})`;
	}
}

const rawValidArb: fc.Arbitrary<RawValid> = fc.record({
	id: fc.string({ minLength: 1, maxLength: 16 }),
	display_name: fc.string({ maxLength: 24 }),
	backend: fc.constantFrom(...BACKENDS),
	family: fc.constantFrom(...FAMILIES),
	languages: fc.array(fc.string({ maxLength: 4 }), { maxLength: 5 }),
	supports_language_detection: fc.boolean(),
	size_label: fc.string({ maxLength: 8 }),
	supports_realtime: fc.boolean(),
	onnx_model_name: fc.option(fc.string({ maxLength: 16 }), { nil: null }),
	description: fc.string({ maxLength: 32 }),
	available_quantizations: fc.array(fc.string({ maxLength: 6 }), { maxLength: 3 }),
});

const invalidRawArb = fc.oneof(
	fc.string(),
	fc.integer(),
	fc.constant(null),
	fc.constant(undefined),
	fc.array(fc.string()),
	fc.record({ id: fc.string(), backend: fc.constant("unknown_backend") }),
	fc.record({ id: fc.string(), family: fc.constant("unknown_family") }),
	fc.record({ displayName: fc.string() }) // camelCase = wrong shape (schema is snake_case)
);

const commandsArb = fc.commands(
	[
		fc
			.tuple(fc.array(rawValidArb, { maxLength: 8 }), fc.array(invalidRawArb, { maxLength: 6 }))
			.map(([valid, invalid]) => new SetModelsCmd(valid, invalid)),
		fc.string({ maxLength: 12 }).map((id) => new GetModelMissCmd(id)),
	],
	{ maxCommands: 25 }
);

test("catalog-store: arbitrary command sequence keeps shape, enum, and selector invariants", () => {
	fc.assert(
		fc.property(commandsArb, (cmds) => {
			resetStore();
			fc.modelRun(() => ({ model: freshModel(), real: useCatalogStore }), cmds);
		}),
		{ numRuns: 60 }
	);
});

// Idempotency: setModels with the same valid payload yields the same observable state.
test("catalog-store: setModels(valid) twice yields identical models length and families", () => {
	fc.assert(
		fc.property(fc.array(rawValidArb, { maxLength: 10 }), (rawList) => {
			resetStore();
			useCatalogStore.getState().setModels(rawList);
			const s1 = useCatalogStore.getState();
			const len1 = s1.models.length;
			const fams1 = s1.getFamilies().sort().join(",");
			useCatalogStore.getState().setModels(rawList);
			const s2 = useCatalogStore.getState();
			const len2 = s2.models.length;
			const fams2 = s2.getFamilies().sort().join(",");
			return len1 === len2 && fams1 === fams2 && s2.isLoaded;
		}),
		{ numRuns: 40 }
	);
});

// Invariant: ALL invalid items together → models stays empty AND isLoaded flips true.
test("catalog-store: setModels with only invalid items leaves models empty but flags loaded", () => {
	fc.assert(
		fc.property(fc.array(invalidRawArb, { minLength: 1, maxLength: 8 }), (invalidList) => {
			resetStore();
			useCatalogStore.getState().setModels(invalidList);
			const s = useCatalogStore.getState();
			return s.models.length === 0 && s.isLoaded === true;
		}),
		{ numRuns: 40 }
	);
});

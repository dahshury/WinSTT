import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "@/entities/setting";
import {
	type ClearableProvider,
	planReverts,
	type RevertPlan,
	type SurfaceSnapshot,
} from "@/features/revert-cloud-on-key-removal";
import {
	type CapabilityId,
	type CapabilitySurfaceSettings,
	hasActiveCapability,
	type IntegrationProvider,
	isKeyedProvider,
	PROVIDER_CAPABILITY_IDS,
	providerCapabilities,
} from "./provider-capabilities";
import { CAPABILITY_MESSAGE } from "../lib/capability-messages";

/**
 * The LLM features default to ENABLED here, which the shipped settings do not:
 * most cases below are about which PROVIDER a surface points at, and leaving
 * them off would make every such case vacuously inactive. The disabled path has
 * its own dedicated cases — it only changes the answer for keyless providers.
 */
function settings(
	over: Partial<{
		dictationEnabled: boolean;
		dictationProvider: string;
		readAloudEnabled: boolean;
		readAloudProvider: string;
		transformsEnabled: boolean;
		transformsProvider: string;
		ttsProvider: string;
		ttsSource: string;
	}> = {},
): CapabilitySurfaceSettings {
	return {
		llm: {
			dictation: {
				enabled: over.dictationEnabled ?? true,
				provider: over.dictationProvider ?? "ollama",
			},
			readAloud: {
				enabled: over.readAloudEnabled ?? true,
				provider: over.readAloudProvider ?? "ollama",
			},
			transforms: {
				enabled: over.transformsEnabled ?? true,
				provider: over.transformsProvider ?? "ollama",
			},
		},
		tts: {
			cloud: { provider: over.ttsProvider ?? "elevenlabs" },
			source: over.ttsSource ?? "local",
		},
	};
}

function ids(
	provider: IntegrationProvider,
	config = settings(),
	activeModelId = "tiny",
): CapabilityId[] {
	return providerCapabilities(provider, config, activeModelId).map((c) => c.id);
}

function activeIds(
	provider: IntegrationProvider,
	config: CapabilitySurfaceSettings,
	activeModelId = "tiny",
): CapabilityId[] {
	return providerCapabilities(provider, config, activeModelId)
		.filter((c) => c.active)
		.map((c) => c.id);
}

describe("capability lists", () => {
	test("ollama gates the three LLM cleanup surfaces", () => {
		expect(ids("ollama")).toEqual(["dictation", "transforms", "readAloud"]);
	});

	test("openrouter gates the LLM surfaces plus cloud STT and cloud voices", () => {
		expect(ids("openrouter")).toEqual([
			"dictation",
			"transforms",
			"readAloud",
			"cloudStt",
			"cloudTts",
		]);
	});

	test("elevenlabs gates cloud STT and cloud voices only", () => {
		expect(ids("elevenlabs")).toEqual(["cloudStt", "cloudTts"]);
	});

	test("the rendered list always matches the declared capability table", () => {
		for (const provider of Object.keys(
			PROVIDER_CAPABILITY_IDS,
		) as IntegrationProvider[]) {
			expect(ids(provider)).toEqual([
				...PROVIDER_CAPABILITY_IDS[provider],
			] as CapabilityId[]);
		}
	});

	test("nothing is active in the all-local default state", () => {
		expect(activeIds("openrouter", settings())).toEqual([]);
		expect(activeIds("elevenlabs", settings())).toEqual([]);
		expect(
			hasActiveCapability(providerCapabilities("openrouter", settings(), "")),
		).toBe(false);
	});
});

describe("a capability flips to active when its surface points at the provider", () => {
	test("dictation cleanup on openrouter", () => {
		expect(
			activeIds("openrouter", settings({ dictationProvider: "openrouter" })),
		).toEqual(["dictation"]);
	});

	test("transforms on openrouter", () => {
		expect(
			activeIds("openrouter", settings({ transformsProvider: "openrouter" })),
		).toEqual(["transforms"]);
	});

	test("read-aloud cleanup tracks its OWN provider, not dictation's", () => {
		expect(
			activeIds("openrouter", settings({ readAloudProvider: "openrouter" })),
		).toEqual(["readAloud"]);
		// Dictation on the cloud must not light up the read-aloud chip.
		expect(
			activeIds("openrouter", settings({ dictationProvider: "openrouter" })),
		).not.toContain("readAloud");
	});

	test("cloud STT lights up from the active model's provider prefix", () => {
		expect(
			activeIds("openrouter", settings(), "openrouter:openai/whisper-1"),
		).toEqual(["cloudStt"]);
		expect(activeIds("elevenlabs", settings(), "elevenlabs:scribe_v1")).toEqual(
			["cloudStt"],
		);
		// A local model selection leaves every cloud STT chip idle.
		expect(activeIds("elevenlabs", settings(), "tiny")).toEqual([]);
	});

	test("cloud voices need BOTH source=cloud and the matching tts provider", () => {
		expect(
			activeIds(
				"elevenlabs",
				settings({ ttsProvider: "elevenlabs", ttsSource: "cloud" }),
			),
		).toEqual(["cloudTts"]);
		// Source still local → the key is not backing anything yet.
		expect(
			activeIds("elevenlabs", settings({ ttsProvider: "elevenlabs" })),
		).toEqual([]);
		// Cloud source, but pointed at the other provider.
		expect(
			activeIds(
				"elevenlabs",
				settings({ ttsProvider: "openrouter", ttsSource: "cloud" }),
			),
		).toEqual([]);
	});

	test("one provider can back several surfaces at once", () => {
		expect(
			activeIds(
				"openrouter",
				settings({
					dictationProvider: "openrouter",
					readAloudProvider: "openrouter",
					transformsProvider: "openrouter",
					ttsProvider: "openrouter",
					ttsSource: "cloud",
				}),
				"openrouter:openai/whisper-1",
			),
		).toEqual(["dictation", "transforms", "readAloud", "cloudStt", "cloudTts"]);
	});

	test("ollama's LLM chips follow its own provider selections", () => {
		expect(
			activeIds(
				"ollama",
				settings({
					dictationProvider: "openrouter",
					readAloudProvider: "ollama",
					transformsProvider: "apple-intelligence",
				}),
			),
		).toEqual(["readAloud"]);
	});

	/**
	 * Ollama has no key and no Remove action, so its chips cannot mean "what
	 * breaks if this is removed" — they can only mean "is this running here".
	 * Every LLM feature ships pointed at ollama with `enabled: false`, so a
	 * provider-match-only rule lit all three chips on a fresh install and told
	 * the user three features were live when none were.
	 */
	test("a keyless provider's chip goes dark when the feature is switched off", () => {
		expect(
			activeIds(
				"ollama",
				settings({
					dictationEnabled: false,
					readAloudEnabled: false,
					transformsEnabled: true,
				}),
			),
		).toEqual(["transforms"]);
	});

	test("a keyless provider with nothing enabled reports no active capability", () => {
		expect(
			activeIds(
				"ollama",
				settings({
					dictationEnabled: false,
					readAloudEnabled: false,
					transformsEnabled: false,
				}),
			),
		).toEqual([]);
	});

	/**
	 * The keyed providers keep the enabled-blind rule ON PURPOSE: their chips
	 * gate a destructive removal, and `planReverts` rewrites a disabled feature
	 * too, so a chip that went dark on `enabled: false` would call the removal
	 * harmless while the planner still changed the setting.
	 */
	test("a keyed provider's chip stays lit even when the feature is switched off", () => {
		expect(
			activeIds(
				"openrouter",
				settings({
					dictationEnabled: false,
					dictationProvider: "openrouter",
					readAloudProvider: "ollama",
					transformsProvider: "ollama",
				}),
			),
		).toContain("dictation");
	});
});

describe("ollama never reports a cloud capability", () => {
	test("cloud ids are absent from the list entirely", () => {
		expect(ids("ollama")).not.toContain("cloudStt");
		expect(ids("ollama")).not.toContain("cloudTts");
	});

	test("even with every cloud surface live and an ollama-ish selection", () => {
		const config = settings({
			dictationProvider: "ollama",
			readAloudProvider: "ollama",
			transformsProvider: "ollama",
			ttsProvider: "openrouter",
			ttsSource: "cloud",
		});
		const capabilities = providerCapabilities(
			"ollama",
			config,
			"openrouter:openai/whisper-1",
		);
		expect(capabilities.map((c) => c.id)).toEqual([
			"dictation",
			"transforms",
			"readAloud",
		]);
		expect(capabilities.every((c) => c.active)).toBe(true);
	});
});

/**
 * The chips answer "what breaks if this key is removed", which is the question
 * `planReverts` already decides. These cases pin the id → RevertPlan mapping
 * across the surface matrix, so a wrong wiring (e.g. cloudTts reading `stt`)
 * fails here rather than shipping a card that lies about a destructive removal.
 */
describe("agreement with planReverts for the removal case", () => {
	const matrix: SurfaceSnapshot[] = [];
	for (const dictationProvider of ["ollama", "openrouter"]) {
		for (const transformsProvider of ["ollama", "openrouter"]) {
			for (const model of [
				"tiny",
				"openrouter:openai/whisper-1",
				"elevenlabs:scribe_v1",
			]) {
				for (const ttsSource of ["local", "cloud"]) {
					for (const ttsProvider of ["elevenlabs", "openrouter"]) {
						matrix.push({
							dictationProvider,
							model,
							transformsProvider,
							ttsProvider,
							ttsSource,
						});
					}
				}
			}
		}
	}

	test("every keyed provider's chips equal the surfaces its removal reverts", () => {
		for (const surfaces of matrix) {
			for (const provider of ["openrouter", "elevenlabs"] as const) {
				const plan = planReverts(new Set([provider]), surfaces);
				const config: CapabilitySurfaceSettings = {
					llm: {
						// Enabled: this suite compares against `planReverts`, which is
						// enabled-blind by design for the keyed providers under test.
						dictation: { enabled: true, provider: surfaces.dictationProvider },
						// planReverts does not model read-aloud; park it on a provider
						// neither card claims so it cannot perturb the comparison.
						readAloud: { enabled: true, provider: "apple-intelligence" },
						transforms: {
							enabled: true,
							provider: surfaces.transformsProvider,
						},
					},
					tts: {
						cloud: { provider: surfaces.ttsProvider },
						source: surfaces.ttsSource,
					},
				};
				const active = new Set(activeIds(provider, config, surfaces.model));
				const declared = new Set(PROVIDER_CAPABILITY_IDS[provider]);
				const expected: Record<CapabilityId, boolean> = {
					cloudStt: plan.stt,
					cloudTts: plan.ttsCloud,
					dictation: plan.llmDictation,
					readAloud: false,
					transforms: plan.llmTransforms,
				};
				for (const id of Object.keys(expected) as CapabilityId[]) {
					// A capability the provider does not gate is simply not rendered;
					// planReverts must agree it is not reverted either.
					expect({ id, provider, surfaces, value: active.has(id) }).toEqual({
						id,
						provider,
						surfaces,
						value: declared.has(id) && expected[id],
					});
				}
			}
		}
	});

	test("a provider nothing points at reverts nothing and shows nothing active", () => {
		const surfaces: SurfaceSnapshot = {
			dictationProvider: "ollama",
			model: "tiny",
			transformsProvider: "ollama",
			ttsProvider: "elevenlabs",
			ttsSource: "local",
		};
		for (const provider of ["openrouter", "elevenlabs"] as const) {
			const plan = planReverts(new Set([provider]), surfaces);
			expect(
				plan.stt || plan.llmDictation || plan.llmTransforms || plan.ttsCloud,
			).toBe(false);
			expect(activeIds(provider, settings(), surfaces.model)).toEqual([]);
		}
	});
});

const KEYED_PROVIDERS: readonly ClearableProvider[] = [
	"elevenlabs",
	"openrouter",
];

/** `planHasWork`, restated so these tests need no extra cross-slice export. */
function planTouchesSomething(plan: RevertPlan): boolean {
	return plan.stt || plan.llmDictation || plan.llmTransforms || plan.ttsCloud;
}

/** A `SurfaceSnapshot` plus the one surface `RevertPlan` does not model. */
interface MatrixRow extends SurfaceSnapshot {
	readAloudProvider: string;
}

function surfaceSettings(row: MatrixRow): CapabilitySurfaceSettings {
	// Enabled throughout: this matrix compares against `planReverts`, which is
	// enabled-blind by design, so varying the flag here would only test the
	// keyless divergence that has its own cases.
	return {
		llm: {
			dictation: { enabled: true, provider: row.dictationProvider },
			readAloud: { enabled: true, provider: row.readAloudProvider },
			transforms: { enabled: true, provider: row.transformsProvider },
		},
		tts: { cloud: { provider: row.ttsProvider }, source: row.ttsSource },
	};
}

/**
 * The surface matrix, this time WITH read-aloud varying. The agreement suite
 * above parks read-aloud on a third provider so it cannot perturb the
 * comparison; these cases prove that parking is not load-bearing — every other
 * capability must still agree with `planReverts` wherever read-aloud points.
 */
const FULL_MATRIX: MatrixRow[] = [];
for (const dictationProvider of ["ollama", "openrouter"]) {
	for (const transformsProvider of ["ollama", "openrouter"]) {
		for (const readAloudProvider of [
			"ollama",
			"openrouter",
			"apple-intelligence",
		]) {
			for (const model of [
				"tiny",
				"openrouter:openai/whisper-1",
				"elevenlabs:scribe_v1",
			]) {
				for (const ttsSource of ["local", "cloud"]) {
					for (const ttsProvider of ["elevenlabs", "openrouter"]) {
						FULL_MATRIX.push({
							dictationProvider,
							model,
							readAloudProvider,
							transformsProvider,
							ttsProvider,
							ttsSource,
						});
					}
				}
			}
		}
	}
}

describe("isKeyedProvider", () => {
	test("the two API-key providers are keyed, ollama is not", () => {
		expect(isKeyedProvider("openrouter")).toBe(true);
		expect(isKeyedProvider("elevenlabs")).toBe(true);
		expect(isKeyedProvider("ollama")).toBe(false);
	});

	test("it partitions the provider union exactly — no third case", () => {
		const providers = Object.keys(
			PROVIDER_CAPABILITY_IDS,
		) as IntegrationProvider[];
		expect(providers.filter(isKeyedProvider).sort()).toEqual([
			"elevenlabs",
			"openrouter",
		]);
		expect(providers.filter((p) => !isKeyedProvider(p))).toEqual(["ollama"]);
	});
});

describe("hasActiveCapability", () => {
	test("false for an empty list and for an all-idle list", () => {
		expect(hasActiveCapability([])).toBe(false);
		expect(
			hasActiveCapability([
				{ active: false, id: "dictation" },
				{ active: false, id: "cloudStt" },
			]),
		).toBe(false);
	});

	test("true as soon as one capability is in use, wherever it sits", () => {
		expect(
			hasActiveCapability([
				{ active: false, id: "dictation" },
				{ active: true, id: "cloudTts" },
			]),
		).toBe(true);
		expect(
			hasActiveCapability(
				providerCapabilities(
					"elevenlabs",
					settings({ ttsProvider: "elevenlabs", ttsSource: "cloud" }),
					"tiny",
				),
			),
		).toBe(true);
	});

	test("it agrees with the chip list it summarises, across the matrix", () => {
		for (const row of FULL_MATRIX) {
			for (const provider of KEYED_PROVIDERS) {
				const config = surfaceSettings(row);
				expect(
					hasActiveCapability(
						providerCapabilities(provider, config, row.model),
					),
				).toBe(activeIds(provider, config, row.model).length > 0);
			}
		}
	});
});

/**
 * `AppSettingsOutput` must stay structurally assignable to the minimal shape
 * this model declares — that assignability is the only thing keeping the hook's
 * field mapping honest. Passing the real defaults exercises it at typecheck time
 * AND pins what a stock install reports.
 */
describe("the real settings object satisfies CapabilitySurfaceSettings", () => {
	test("a fresh install lights nothing: every card lists its chips, none active", () => {
		// The shipped defaults point every LLM feature at ollama but leave all three
		// DISABLED, and no cloud surface is selected. So the tab a new user opens
		// must show three full capability lists with not one "Active" marker —
		// claiming otherwise (as a provider-match-only rule did) tells them
		// features are running before they have turned anything on.
		const model = DEFAULT_SETTINGS.model?.model ?? "";
		for (const provider of Object.keys(
			PROVIDER_CAPABILITY_IDS,
		) as IntegrationProvider[]) {
			const capabilities = providerCapabilities(
				provider,
				DEFAULT_SETTINGS,
				model,
			);
			expect(capabilities.map((c) => c.id)).toEqual([
				...PROVIDER_CAPABILITY_IDS[provider],
			]);
			expect({ active: hasActiveCapability(capabilities), provider }).toEqual({
				active: false,
				provider,
			});
		}
	});
});

/**
 * The load-bearing invariant. The chips and `planReverts` answer the same
 * question — "what is this key holding up right now?" — down two different code
 * paths, and this rework exists because those paths had drifted. If the planner
 * would rewrite ANY surface, the card must show at least one active capability;
 * otherwise the remove-confirmation gate is skipped and settings are rewritten
 * with no warning at all.
 */
describe("the chips can never under-report what removal would rewrite", () => {
	test("a plan with work implies at least one active chip, across the matrix", () => {
		for (const row of FULL_MATRIX) {
			for (const provider of KEYED_PROVIDERS) {
				if (!planTouchesSomething(planReverts(new Set([provider]), row))) {
					continue;
				}
				const active = hasActiveCapability(
					providerCapabilities(provider, surfaceSettings(row), row.model),
				);
				expect({ active, provider, row }).toEqual({
					active: true,
					provider,
					row,
				});
			}
		}
	});

	test("every reverted surface maps to a chip that is both declared and active", () => {
		const SURFACE_TO_CAPABILITY: Record<keyof RevertPlan, CapabilityId> = {
			llmDictation: "dictation",
			llmTransforms: "transforms",
			stt: "cloudStt",
			ttsCloud: "cloudTts",
		};
		const keys = Object.keys(SURFACE_TO_CAPABILITY) as (keyof RevertPlan)[];
		for (const row of FULL_MATRIX) {
			for (const provider of KEYED_PROVIDERS) {
				const plan = planReverts(new Set([provider]), row);
				const active = new Set(
					activeIds(provider, surfaceSettings(row), row.model),
				);
				const declared = new Set<CapabilityId>(
					PROVIDER_CAPABILITY_IDS[provider],
				);
				for (const key of keys.filter((k) => plan[k])) {
					const id = SURFACE_TO_CAPABILITY[key];
					expect({
						declared: declared.has(id),
						id,
						key,
						provider,
						shown: active.has(id),
					}).toEqual({ declared: true, id, key, provider, shown: true });
				}
			}
		}
	});

	test("read-aloud is the ONLY chip that can be active with nothing to revert", () => {
		// Characterisation of the known planner gap: `RevertPlan` has no
		// `llmReadAloud` field, so removing an OpenRouter key that ONLY read-aloud
		// points at reverts nothing. When the planner grows that field this test
		// must be deleted rather than relaxed — at that point the chip and the plan
		// agree everywhere and the exception disappears.
		for (const row of FULL_MATRIX) {
			for (const provider of KEYED_PROVIDERS) {
				if (planTouchesSomething(planReverts(new Set([provider]), row))) {
					continue;
				}
				const orphanedReadAloud =
					provider === "openrouter" && row.readAloudProvider === "openrouter";
				expect({
					active: activeIds(provider, surfaceSettings(row), row.model),
					provider,
					row,
				}).toEqual({
					active: orphanedReadAloud ? ["readAloud"] : [],
					provider,
					row,
				});
			}
		}
	});

	test("read-aloud on elevenlabs is not even a chip on the ElevenLabs card", () => {
		// ElevenLabs gates no LLM surface, so a stray `llm.readAloud.provider` of
		// "elevenlabs" must not invent a capability that card cannot back.
		const config = settings({ readAloudProvider: "elevenlabs" });
		expect(ids("elevenlabs", config)).toEqual(["cloudStt", "cloudTts"]);
		expect(activeIds("elevenlabs", config)).toEqual([]);
	});
});

/**
 * Removing both keys at once is ONE `planReverts` call with a two-element set,
 * while the cards each ask about a single provider. The two views must add up.
 */
describe("clearing both providers is the union of the two cards", () => {
	test("a combined plan reverts exactly what the two single plans do", () => {
		for (const row of FULL_MATRIX) {
			const both = planReverts(
				new Set<ClearableProvider>(["elevenlabs", "openrouter"]),
				row,
			);
			const each = KEYED_PROVIDERS.map((p) => planReverts(new Set([p]), row));
			expect(both).toEqual({
				llmDictation: each.some((p) => p.llmDictation),
				llmTransforms: each.some((p) => p.llmTransforms),
				stt: each.some((p) => p.stt),
				ttsCloud: each.some((p) => p.ttsCloud),
			});
		}
	});

	test("a surface is claimed by at most one provider card at a time", () => {
		// Two cards both reporting "Cloud transcription — currently in use" would
		// mean two keys hold up one selection, which is not a state that exists.
		const providers = Object.keys(
			PROVIDER_CAPABILITY_IDS,
		) as IntegrationProvider[];
		for (const row of FULL_MATRIX) {
			const config = surfaceSettings(row);
			const owners = new Map<CapabilityId, IntegrationProvider[]>();
			for (const provider of providers) {
				for (const id of activeIds(provider, config, row.model)) {
					owners.set(id, [...(owners.get(id) ?? []), provider]);
				}
			}
			for (const [id, claimants] of owners) {
				expect({ claimants: claimants.length, id, row }).toEqual({
					claimants: 1,
					id,
					row,
				});
			}
		}
	});
});

/**
 * The capability model exposes ids and no English at all, so `CAPABILITY_MESSAGE`
 * is the single place the two vocabularies meet. `as const satisfies` proves the
 * record is TOTAL over `CapabilityId` at compile time but says nothing about the
 * values being real message keys — a chip whose key is missing renders the raw
 * key to the user, which is exactly what the i18n literal guard cannot catch.
 */
describe("every capability id resolves to a real message", () => {
	test("the map covers every declared capability, and nothing else", async () => {
		const declared = new Set<CapabilityId>(
			Object.values(PROVIDER_CAPABILITY_IDS).flatMap((list) => [...list]),
		);
		expect([...Object.keys(CAPABILITY_MESSAGE)].sort()).toEqual(
			[...declared].sort(),
		);

		const en = (await Bun.file(
			new URL("../../../../messages/en.json", import.meta.url),
		).json()) as { integrations: Record<string, string | undefined> };
		for (const [id, key] of Object.entries(CAPABILITY_MESSAGE)) {
			expect({ id, key, text: en.integrations[key]?.trim() || null }).toEqual({
				id,
				key,
				text: expect.any(String),
			});
		}
	});

	test("no two capabilities share a label", () => {
		// Distinct chips must read distinctly, or the card cannot say which
		// surface is in use.
		const keys = Object.values(CAPABILITY_MESSAGE);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

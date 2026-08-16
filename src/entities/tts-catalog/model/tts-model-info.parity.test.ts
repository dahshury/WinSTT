import { describe, expect, test } from "bun:test";
// Imported by RELATIVE path on purpose: the fixture lives under spec/fixtures/
// (the `@spec/*` alias does not cover it and is being retired).
import fields from "../../../../spec/fixtures/tts-model-info.fields.json";
import { rawTtsModelSchema } from "./tts-catalog-store";

// Rust↔zod TTS-catalog-DTO key parity gate — the TTS twin of
// `catalog-model-info.parity.test.ts`.
//
// `spec/fixtures/tts-model-info.fields.json` is the CANONICAL wire-key set of the
// backend's `TtsModelInfoDto` (src-tauri/.../commands/tts.rs), written from Rust by
// `cargo run --example export_catalog_parity_fixtures` and asserted current on the
// Rust side (`tts::tests::tts_model_dto_fields_match_committed`).
//
// The renderer receives that payload through the typed `commands.ttsListModelsWithState()`
// binding, but `setModels` takes `unknown[]` and re-parses through the HAND-WRITTEN
// `rawTtsModelSchema` — so `tsc` sees nothing when the two drift. And the drift is
// silent at runtime too: `applyRaw` uses `safeParse` and DROPS rows that fail, so a
// renamed field or an unlisted enum variant empties the model picker with no error in
// the console. This test fails the moment the two key sets diverge, in either direction.
describe("TTS catalog DTO: Rust↔zod key parity", () => {
	test("rawTtsModelSchema keys reproduce the Rust TtsModelInfoDto field set", () => {
		const zodKeys = Object.keys(rawTtsModelSchema.shape).sort();
		expect(zodKeys).toEqual([...fields].sort());
	});

	test("every wire key is optional — an old server's row must never be dropped", () => {
		// The compat contract the whole schema is written to: a server that predates
		// any one field still yields a parseable row. `id`/`engine`/`display_name` are
		// the identity of the row and are exempt — a row without them is not a model.
		const identity = new Set(["id", "engine", "display_name"]);
		const full: Record<string, unknown> = {
			id: "chatterbox-turbo",
			engine: "chatterbox",
			display_name: "Chatterbox Turbo",
			maker: "Resemble AI",
			languages: ["en"],
			num_voices: 0,
			cloning: "zero_shot_audio",
			requires_reference_clip: false,
			voice_design: false,
			voice_design_max_chars: 0,
			voice_instruct: false,
			max_ref_clip_secs: 30,
			tag_syntax: "square",
			tags: ["laugh", "cough", "chuckle"],
			sample_rate: 24_000,
			param_count_m: 500,
			size_label: "500 MB",
			available_quantizations: ["q4f16"],
			size_bytes_by_quantization: { q4f16: 1 },
			quality_score: 0.8,
			speed_score: 0.8,
			description: "",
			available: true,
		};
		// Guard against this fixture row itself going stale relative to the wire.
		expect(Object.keys(full).sort()).toEqual([...fields].sort());

		for (const key of fields) {
			if (identity.has(key)) {
				continue;
			}
			const { [key]: _dropped, ...withoutField } = full;
			const parsed = rawTtsModelSchema.safeParse(withoutField);
			expect(
				parsed.success,
				`omitting "${key}" drops the row — add a .default() for it in rawTtsModelSchema, or the whole picker empties`,
			).toBe(true);
		}
	});
});

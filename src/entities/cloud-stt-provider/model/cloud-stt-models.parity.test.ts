import { describe, expect, test } from "bun:test";
import type { CloudSttProvider } from "@/shared/api/models";
// Imported by RELATIVE path on purpose: the fixture lives under spec/fixtures/
// (the `@spec/*` alias does not cover it and is being retired).
import fixture from "../../../../spec/fixtures/cloud-stt-models.json";
import { CURATED_CLOUD_MODELS } from "./catalog";

// Rust↔TS curated cloud-STT catalog parity gate.
//
// `spec/fixtures/cloud-stt-models.json` is the CANONICAL curated catalog, written
// from Rust's `ELEVENLABS_CLOUD_MODELS` (src-tauri/.../cloud_stt.rs) by
// `cargo run --example export_catalog_parity_fixtures` and asserted current on the
// Rust side (`cloud_stt::tests::cloud_models_fixture_matches_committed`).
//
// The renderer's picker reads its OWN hardcoded `CURATED_CLOUD_MODELS` — the backend
// row is only used to default/validate an id — so the two tables must agree by hand.
// This test makes that agreement enforced instead of comment-asserted.

// Normalize both sides to a stable shape: the TS entries omit `description`/`isDefault`
// when absent, whereas the Rust struct always emits them — collapse those to their
// documented defaults ("" / false) so the comparison is on real content, not optionality.
type NormalizedModel = {
	id: string;
	displayName: string;
	description: string;
	isDefault: boolean;
};

function normalize(model: {
	id: string;
	displayName: string;
	description?: string;
	isDefault?: boolean;
}): NormalizedModel {
	return {
		id: model.id,
		displayName: model.displayName,
		description: model.description ?? "",
		isDefault: model.isDefault ?? false,
	};
}

describe("curated cloud STT catalog: Rust↔TS parity", () => {
	const providers = Object.keys(fixture) as CloudSttProvider[];

	for (const provider of providers) {
		test(`${provider} curated models reproduce the Rust fixture`, () => {
			const expected = fixture[provider].map(normalize);
			const actual = CURATED_CLOUD_MODELS[provider].map(normalize);
			expect(actual).toEqual(expected);
		});
	}

	test("fixture covers exactly the providers the renderer curates", () => {
		expect(Object.keys(fixture).sort()).toEqual(
			Object.keys(CURATED_CLOUD_MODELS).sort(),
		);
	});
});

import { describe, expect, test } from "bun:test";
// Imported by RELATIVE path on purpose: the fixture lives under spec/fixtures/
// (the `@spec/*` alias does not cover it and is being retired).
import fields from "../../../../spec/fixtures/catalog-model-info.fields.json";
import { rawModelInfoSchema } from "./catalog-store";

// Rust↔zod catalog-DTO key parity gate.
//
// `spec/fixtures/catalog-model-info.fields.json` is the CANONICAL wire-key set of
// the backend's `CatalogModelInfo` DTO (src-tauri/.../catalog_data/dto.rs), written
// from Rust by `cargo run --example export_catalog_parity_fixtures` and asserted
// current on the Rust side (`dto::tests::catalog_dto_fields_match_committed`).
//
// The renderer parses catalog payloads through `rawModelInfoSchema` — NOT the
// generated `CatalogModelInfo` binding — because the payload arrives over the
// WS-polyfill adapter path rather than a typed `commands.*` call. That hand-written
// zod schema is the drift risk: a field added to the Rust DTO silently never reaches
// the renderer until someone also edits the schema. This test fails the moment the
// two key sets diverge, in either direction.
describe("catalog DTO: Rust↔zod key parity", () => {
	test("rawModelInfoSchema keys reproduce the Rust CatalogModelInfo field set", () => {
		const zodKeys = Object.keys(rawModelInfoSchema.shape).sort();
		expect(zodKeys).toEqual([...fields].sort());
	});
});

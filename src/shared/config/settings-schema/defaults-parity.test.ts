import { describe, expect, test } from "bun:test";
// Imported by RELATIVE path on purpose: the fixture lives under spec/fixtures/
// (not spec/generated/ts/), so the `@spec/*` alias does not cover it, and the
// alias is being retired.
import fixture from "../../../../spec/fixtures/winstt-settings.default.json";
import { appSettingsSchema } from "./index";

// Rust↔zod settings-defaults parity gate (audit M3 step 1 / task 2.3).
//
// `spec/fixtures/winstt-settings.default.json` is the CANONICAL settings-default
// surface, written from Rust by `cargo run --example export_settings_fixture`
// (it serializes `WinsttSettings::default()` minus the backend-only `core`
// section). The Rust side asserts the fixture is current
// (`settings_schema::tests::default_fixture_matches_committed`); this test
// asserts the zod schema reproduces the exact same tree from an empty input, so
// any drift between the two default sources fails CI.
describe("settings defaults: Rust↔zod parity", () => {
	test("appSettingsSchema.parse({}) deep-equals the Rust fixture", () => {
		const zodDefaults = appSettingsSchema.parse({});

		// The fixture is already the renderer-facing surface: the Rust exporter
		// strips `core` (the backend-only embedded AppSettings view — bindings,
		// paste/clipboard, legacy post_process_*, accelerators, tray/debug
		// toggles) which zod never models. So `core` is not present in the
		// fixture and nothing extra needs excluding here; this asserts exactly the
		// shared surface both schemas must agree on.
		expect(fixture).not.toHaveProperty("core");

		expect(zodDefaults).toEqual(fixture);
	});
});

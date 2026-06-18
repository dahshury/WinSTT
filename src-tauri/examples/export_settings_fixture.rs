// Regenerates the committed Rust↔zod settings-defaults parity fixture.
//
//   cargo run --example export_settings_fixture
//
// Rust is the canonical source for every settings default. This example
// serializes `WinsttSettings::default()` (secrets are empty in the defaults) and
// writes the renderer-facing surface to `spec/fixtures/winstt-settings.default.json`.
// The committed fixture is then asserted from two sides:
//   - Rust:  `settings_schema::tests::default_fixture_matches_committed`
//   - zod:   `src/shared/config/settings-schema/defaults-parity.test.ts`
//
// The `core` section is excluded on purpose: it is the backend-only `AppSettings`
// view (bindings map, paste/clipboard subsystem, legacy post_process_* fields,
// accelerators, tray/debug toggles) which the renderer never sees — zod strips it
// from the shared schema. It also carries machine-dependent defaults
// (`app_language` reads the host locale) and `HashMap` fields whose JSON order is
// non-deterministic, so it cannot live in a byte-stable committed fixture. The
// fixture is therefore exactly the shared surface both sides must agree on.
//
// The mirrored regeneration / comparison logic lives in
// `winstt_app_lib::winstt::settings_schema::default_fixture_json` so this example
// and the Rust test stay in lockstep.

use std::path::Path;

use winstt_app_lib::winstt::settings_schema::default_fixture_json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let json = default_fixture_json()?;
    // `CARGO_MANIFEST_DIR` is `src-tauri`; the fixture lives at the repo root.
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("spec")
        .join("fixtures")
        .join("winstt-settings.default.json");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, json)?;
    println!("wrote {}", path.display());
    Ok(())
}

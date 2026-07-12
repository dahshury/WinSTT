// Regenerates the committed Rust↔TS catalog parity fixtures.
//
//   cargo run --example export_catalog_parity_fixtures
//
// Rust is the canonical source for both surfaces. Two fixtures are written under
// `spec/fixtures/` and each is asserted from both sides so a one-sided edit fails CI:
//
//   - `catalog-model-info.fields.json` — the sorted `CatalogModelInfo` wire-key set.
//       Rust: `winstt::commands::catalog_data::dto::tests::catalog_dto_fields_match_committed`
//       TS:   `src/entities/model-catalog/model/catalog-model-info.parity.test.ts`
//              (asserts `rawModelInfoSchema`'s keys reproduce it)
//
//   - `cloud-stt-models.json` — the curated cloud-STT catalog in the renderer's
//     camelCase `CloudModel` shape.
//       Rust: `winstt::cloud_stt::tests::cloud_models_fixture_matches_committed`
//       TS:   `src/entities/cloud-stt-provider/model/cloud-stt-models.parity.test.ts`
//              (asserts `CURATED_CLOUD_MODELS` reproduces it)
//
// The generation logic lives next to each data source (`catalog_dto_fields_json`,
// `cloud_models_fixture_json`) so this example and the Rust tests stay in lockstep.

use std::path::{Path, PathBuf};

use winstt_app_lib::winstt::cloud_stt::cloud_models_fixture_json;
use winstt_app_lib::winstt::commands::catalog_data::catalog_dto_fields_json;

fn fixtures_dir() -> PathBuf {
    // `CARGO_MANIFEST_DIR` is `src-tauri`; the fixtures live at the repo root.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("spec")
        .join("fixtures")
}

fn write(dir: &Path, name: &str, contents: &str) -> std::io::Result<()> {
    let path = dir.join(name);
    std::fs::write(&path, contents)?;
    println!("wrote {}", path.display());
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = fixtures_dir();
    std::fs::create_dir_all(&dir)?;
    write(
        &dir,
        "catalog-model-info.fields.json",
        &catalog_dto_fields_json()?,
    )?;
    write(&dir, "cloud-stt-models.json", &cloud_models_fixture_json()?)?;
    Ok(())
}

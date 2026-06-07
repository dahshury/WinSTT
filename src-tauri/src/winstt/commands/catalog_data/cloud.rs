// ── Cloud STT catalog (openai / elevenlabs) ─────────────────────────────────────────────────────
//
// IMPORTANT: cloud STT models are DELIBERATELY NOT folded into `catalog_rows()` /
// `models_with_state()`. The reused React renderer routes its picker between the LOCAL grid
// (`list_models` → `catalog_rows`, schema `rawModelInfoSchema`) and the CLOUD picker
// (`features/select-cloud-stt-model`, which reads its own hardcoded `CLOUD_CATALOG` — never the
// backend) purely off the `openai:` / `elevenlabs:` prefix (`providerOf`). Cloud rows have none of
// the local-engine editorial fields the local grid requires (per-quant byte sizes, WER/RTFx,
// quant set), so injecting them into `catalog_rows()` would surface malformed local cards.
//
// This block is the BACKEND-SIDE MIRROR of the renderer's `CLOUD_CATALOG` (byte-identical ids /
// defaults), exposed as a specta-typed payload so a future "enumerate cloud STT models" command
// (or settings-validation) has a single source of truth. The authoritative pure table lives in
// `winstt::cloud_stt` (`OPENAI_CLOUD_MODELS` / `ELEVENLABS_CLOUD_MODELS`); this only reshapes it.

use serde::{Deserialize, Serialize};
use specta::Type;

/// One cloud STT model as the picker would consume it. snake_case on the wire to match the
/// renderer's `CloudModel` shape. `model` is the prefixed `<provider>:<id>` the picker persists
/// into `settings.model.model`; `id` is the bare provider model id.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct CloudCatalogModel {
    /// Bare provider model id (e.g. `whisper-1`).
    pub id: String,
    /// Prefixed `<provider>:<id>` selectable id (e.g. `openai:whisper-1`).
    pub model: String,
    pub provider: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
}

/// The cloud STT catalog for one provider id (`"openai"` / `"elevenlabs"`); empty for unknown.
pub fn cloud_catalog_rows(provider_id: &str) -> Vec<CloudCatalogModel> {
    use crate::winstt::cloud_stt::{cloud_models_for, CloudSttProvider};

    let Some(provider) = CloudSttProvider::from_id(provider_id) else {
        return Vec::new();
    };
    cloud_models_for(provider)
        .iter()
        .map(|m| CloudCatalogModel {
            id: m.id.to_string(),
            model: format!("{}:{}", provider.id(), m.id),
            provider: provider.id().to_string(),
            display_name: m.display_name.to_string(),
            description: m.description.to_string(),
            is_default: m.is_default,
        })
        .collect()
}

/// The full cloud STT catalog across every provider, flattened. Drives any backend
/// enumerate-cloud-models surface.
pub fn all_cloud_catalog_rows() -> Vec<CloudCatalogModel> {
    let mut rows = cloud_catalog_rows("openai");
    rows.extend(cloud_catalog_rows("elevenlabs"));
    rows
}

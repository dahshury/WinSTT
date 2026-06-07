// Renderer payload DTOs + `From` conversions mirroring spec/openapi.yaml exactly.
// Split out of the `llm` command root; re-exported there to keep public paths.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::winstt::managers::llm_manager::{
    OllamaModelDetails as MgrDetails, OllamaModelInfo as MgrModel, OpenRouterEndpointInfo,
    OpenRouterModelInfo,
};

// ── Renderer payload shapes (mirror spec/openapi.yaml exactly) ─────────────────

/// `OllamaModelDetails` (camelCase per spec).
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelDetailsPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub families: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantization_level: Option<String>,
}

impl From<MgrDetails> for OllamaModelDetailsPayload {
    fn from(d: MgrDetails) -> Self {
        Self {
            format: d.format,
            family: d.family,
            families: d.families,
            parameter_size: d.parameter_size,
            quantization_level: d.quantization_level,
        }
    }
}

/// `OllamaModel` (camelCase per spec). Consumed by `OllamaScanResult.models[]`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelPayload {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<OllamaModelDetailsPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
}

impl From<MgrModel> for OllamaModelPayload {
    fn from(m: MgrModel) -> Self {
        Self {
            name: m.name,
            size: m.size,
            modified_at: m.modified_at,
            details: m.details.map(Into::into),
            capabilities: m.capabilities,
            context_length: m.context_length,
        }
    }
}

/// `OllamaScanResult` — the shape `useLlmCatalogStore.scanModels()` consumes.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaScanResultPayload {
    pub models: Vec<OllamaModelPayload>,
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `OllamaDetectResult` — `{ installed, path? }`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaDetectResultPayload {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// `{ started, error? }` — the `startOllama()` IPC result.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStartResultPayload {
    pub started: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `OllamaPullResult` — `{ success, model, cancelled?, error? }`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaPullResultPayload {
    pub success: bool,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `OllamaDeleteResult` — `{ success, model, error? }`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaDeleteResultPayload {
    pub success: bool,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `OpenRouterModel` (snake_case keys per spec — NOT renamed).
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
pub struct OpenRouterModelPayload {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_parameters: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoints: Option<Vec<OpenRouterEndpointPayload>>,
}

/// `OpenRouterEndpoint` (snake_case keys per spec — NOT renamed). One hosting
/// endpoint row driving the picker's provider rail / per-provider pricing / quant
/// + feature chips. `pricing` stays opaque JSON, like the model-level `pricing`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
pub struct OpenRouterEndpointPayload {
    pub name: String,
    pub model_name: String,
    pub context_length: i64,
    pub pricing: serde_json::Value,
    pub provider_name: String,
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_completion_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_parameters: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_last_30m: Option<f64>,
}

impl From<OpenRouterEndpointInfo> for OpenRouterEndpointPayload {
    fn from(e: OpenRouterEndpointInfo) -> Self {
        Self {
            name: e.name,
            model_name: e.model_name,
            context_length: e.context_length,
            pricing: e.pricing,
            provider_name: e.provider_name,
            tag: e.tag,
            max_completion_tokens: e.max_completion_tokens,
            supported_parameters: e.supported_parameters,
            quantization: e.quantization,
            status: e.status,
            uptime_last_30m: e.uptime_last_30m,
        }
    }
}

impl From<OpenRouterModelInfo> for OpenRouterModelPayload {
    fn from(m: OpenRouterModelInfo) -> Self {
        Self {
            id: m.id,
            name: m.name,
            description: m.description,
            context_length: m.context_length,
            pricing: m.pricing,
            provider: m.provider,
            maker: m.maker,
            model_name: m.model_name,
            variant: m.variant,
            architecture: m.architecture,
            supported_parameters: m.supported_parameters,
            endpoints: m
                .endpoints
                .map(|eps| eps.into_iter().map(Into::into).collect()),
        }
    }
}

/// `OpenRouterScanResult` — `{ models, reachable, error? }`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterScanResultPayload {
    pub models: Vec<OpenRouterModelPayload>,
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Verify-credential outcome — `{ ok, code?, message? }`. The renderer's
/// verify-credentials feature reads `code === "network"` to split offline from
/// invalid, so `code` MUST be the WinSTT taxonomy string.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VerifyCredentialPayload {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

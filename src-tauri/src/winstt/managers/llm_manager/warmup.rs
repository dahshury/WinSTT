// Ollama warmup lifecycle: the app-lifetime periodic keep-alive loop, reachability
// + auto-start, stale-model eviction, per-model warmup, and status publishing.
// Lives in a second `impl LlmManager` block so it shares the struct's private fields.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::Emitter;

use super::{
    LlmManager, LLM_WARMUP_PASS_KEY, OLLAMA_BOOT_WAIT, OLLAMA_EVICT_TIMEOUT,
    OLLAMA_RECENT_WARM_SKIP, OLLAMA_WARMUP_INTERVAL, OLLAMA_WARMUP_TIMEOUT,
};
use crate::winstt::commands::ollama_pull::{
    clear_warmup_status as clear_last_warmup_status, set_warmup_status, LlmWarmupModelStatus,
    LlmWarmupOutcome, LlmWarmupStatus,
};
use crate::winstt::commands::settings::{enabled_ollama_models, read_settings};
use crate::winstt::llm::validate_loopback_ollama_endpoint;
use crate::winstt::ollama_client::OllamaLoadResult;

fn warmup_timestamp() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

fn llm_model_key(endpoint: &str, model: &str) -> String {
    format!("llm\0{endpoint}\0{model}")
}

fn llm_endpoint_prefix(endpoint: &str) -> String {
    format!("llm\0{endpoint}\0")
}

fn llm_model_from_key<'a>(key: &'a str, endpoint: &str) -> Option<&'a str> {
    key.strip_prefix(&llm_endpoint_prefix(endpoint))
}

fn is_loopback_ollama_endpoint(endpoint: &str) -> bool {
    validate_loopback_ollama_endpoint(endpoint).is_ok()
}

impl LlmManager {
    pub fn start_warmup_loop(self: &Arc<Self>) {
        if self
            .warmup_loop_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        let mgr = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                mgr.warm_enabled_models().await;
                tokio::time::sleep(OLLAMA_WARMUP_INTERVAL).await;
            }
        });
    }

    pub async fn warm_enabled_models(&self) {
        let Some(_pass) = self.lifecycle.try_claim(LLM_WARMUP_PASS_KEY) else {
            return;
        };

        let settings = read_settings(&self.app);
        let endpoint = settings.llm.endpoint.clone();
        let models = enabled_ollama_models(&settings);
        if models.is_empty() {
            self.evict_stale_warmed_models(&endpoint, &[]).await;
            self.clear_warmup_status();
            return;
        }

        self.cancel_all();
        let (reachable, ollama_installed) = self.ensure_ollama_reachable(&endpoint).await;
        if !reachable {
            self.publish_warmup_status(LlmWarmupStatus {
                endpoint,
                in_progress: false,
                models: models
                    .into_iter()
                    .map(|model| LlmWarmupModelStatus {
                        model,
                        outcome: LlmWarmupOutcome::Unreachable,
                        error_body: None,
                    })
                    .collect(),
                ollama_installed,
                reachable: false,
                timestamp: warmup_timestamp(),
            });
            return;
        }

        self.publish_warmup_status(LlmWarmupStatus {
            endpoint: endpoint.clone(),
            in_progress: true,
            models: models
                .iter()
                .map(|model| LlmWarmupModelStatus {
                    model: model.clone(),
                    outcome: LlmWarmupOutcome::Loading,
                    error_body: None,
                })
                .collect(),
            ollama_installed,
            reachable: true,
            timestamp: warmup_timestamp(),
        });

        self.evict_stale_warmed_models(&endpoint, &models).await;

        let keep_alive = self.ollama_keep_alive();
        let mut results = Vec::with_capacity(models.len());
        for model in &models {
            results.push(
                self.warmup_ollama_model(&endpoint, model, keep_alive.clone())
                    .await,
            );
        }

        self.publish_warmup_status(LlmWarmupStatus {
            endpoint,
            in_progress: false,
            models: results,
            ollama_installed,
            reachable: true,
            timestamp: warmup_timestamp(),
        });
    }

    async fn ensure_ollama_reachable(&self, endpoint: &str) -> (bool, bool) {
        if self.ollama_detect(endpoint).await {
            return (true, true);
        }
        if !is_loopback_ollama_endpoint(endpoint) {
            return (false, false);
        }
        let detected = crate::winstt::commands::llm::detect_ollama_executable().await;
        let Some(path) = detected.path else {
            return (false, detected.installed);
        };
        if let Err(err) = crate::winstt::commands::llm::spawn_ollama_serve(&path) {
            log::debug!("[llm] Ollama auto-start failed: {err}");
            return (false, true);
        }
        (self.wait_for_ollama(endpoint, OLLAMA_BOOT_WAIT).await, true)
    }

    async fn wait_for_ollama(&self, endpoint: &str, total: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + total;
        loop {
            if self.ollama_detect(endpoint).await {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn evict_stale_warmed_models(&self, endpoint: &str, active_models: &[String]) {
        let stale = self.stale_warmed_models(endpoint, active_models);
        for model in stale {
            self.unload_ollama_model(endpoint, &model).await;
            self.lifecycle.clear_warm(&llm_model_key(endpoint, &model));
        }
    }

    fn stale_warmed_models(&self, endpoint: &str, active_models: &[String]) -> Vec<String> {
        let active: HashSet<String> = active_models
            .iter()
            .map(|model| llm_model_key(endpoint, model))
            .collect();
        self.lifecycle
            .warm_keys()
            .into_iter()
            .filter(|key| key.starts_with(&llm_endpoint_prefix(endpoint)))
            .filter(|key| !active.contains(key))
            .filter_map(|key| llm_model_from_key(&key, endpoint).map(str::to_string))
            .collect()
    }

    async fn unload_ollama_model(&self, endpoint: &str, model: &str) {
        self.ollama
            .unload_model(endpoint, model, OLLAMA_EVICT_TIMEOUT)
            .await;
    }

    pub(super) fn mark_ollama_model_warm(&self, endpoint: &str, model: &str) {
        if !model.trim().is_empty() {
            self.lifecycle.mark_warm(llm_model_key(endpoint, model));
        }
    }

    async fn warmup_ollama_model(
        &self,
        endpoint: &str,
        model: &str,
        keep_alive: serde_json::Value,
    ) -> LlmWarmupModelStatus {
        if model.trim().is_empty() {
            return LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: LlmWarmupOutcome::Skipped,
                error_body: None,
            };
        }

        let model_key = llm_model_key(endpoint, model);
        if self
            .lifecycle
            .is_warm_within(&model_key, OLLAMA_RECENT_WARM_SKIP)
        {
            return LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: LlmWarmupOutcome::Ok,
                error_body: None,
            };
        }
        let Some(_claim) = self.lifecycle.try_claim(model_key.clone()) else {
            return LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: LlmWarmupOutcome::Loading,
                error_body: None,
            };
        };

        match self
            .ollama
            .warmup_model(endpoint, model, keep_alive, OLLAMA_WARMUP_TIMEOUT)
            .await
        {
            OllamaLoadResult::Ok => {
                self.lifecycle.mark_warm(model_key);
                log::debug!("[llm] Ollama warm-up OK: {model}");
                LlmWarmupModelStatus {
                    model: model.to_string(),
                    outcome: LlmWarmupOutcome::Ok,
                    error_body: None,
                }
            }
            OllamaLoadResult::Transport(err) => LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: LlmWarmupOutcome::Unreachable,
                error_body: Some(err),
            },
            OllamaLoadResult::Http { status, body } => LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: if status == 404 {
                    LlmWarmupOutcome::ModelNotFound
                } else {
                    LlmWarmupOutcome::LoadFailed
                },
                error_body: if body.is_empty() { None } else { Some(body) },
            },
        }
    }

    fn publish_warmup_status(&self, status: LlmWarmupStatus) {
        set_warmup_status(status.clone());
        let _ = self.app.emit("llm:warmup-status", status);
    }

    fn clear_warmup_status(&self) {
        clear_last_warmup_status();
        let _ = self
            .app
            .emit("llm:warmup-status", Option::<LlmWarmupStatus>::None);
    }
}

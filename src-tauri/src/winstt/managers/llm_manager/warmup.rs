// Ollama warmup lifecycle: the app-lifetime periodic keep-alive loop, reachability
// + auto-start, stale-model eviction, per-model warmup, and status publishing.
// Lives in a second `impl LlmManager` block so it shares the struct's private fields.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::Emitter;

use super::{
    LlmManager, LLM_WARMUP_PASS_KEY, OLLAMA_BOOT_WAIT, OLLAMA_EVICT_TIMEOUT,
    OLLAMA_LOAD_FAIL_BACKOFF, OLLAMA_RECENT_WARM_SKIP, OLLAMA_WARMUP_INTERVAL,
    OLLAMA_WARMUP_TIMEOUT, OLLAMA_WARM_TRIGGER_ATTEMPTS, OLLAMA_WARM_TRIGGER_RETRY_DELAY,
};
use crate::winstt::commands::ollama_pull::{
    clear_warmup_status as clear_last_warmup_status, set_warmup_status, LlmWarmupModelStatus,
    LlmWarmupOutcome, LlmWarmupStatus,
};
use crate::winstt::commands::settings::enabled_ollama_models;
use crate::winstt::llm::validate_loopback_ollama_endpoint;
use crate::winstt::model_watchdog;
use crate::winstt::ollama_client::OllamaLoadResult;
use crate::winstt::settings_store::read_settings_raw;

fn warmup_timestamp() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_millis() as f64)
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

/// Drive `pass` up to `attempts` times, returning `true` the moment it succeeds
/// and sleeping `delay` between tries (never after the last). This is the
/// freshly-triggered-warm safety net: a warm pass returns `false` when it lost
/// the pass-claim to an in-flight pass or Ollama was momentarily unreachable
/// (just auto-spawned at boot, busy unloading the previous model during a
/// switch). Without these quick retries the model would stay cold until the 60s
/// periodic tick — the user-visible "first post-process is slow" gap. After the
/// budget is spent the periodic loop keeps the long-term retry going.
async fn retry_until_complete<F, Fut>(
    attempts: u32,
    delay: Duration,
    reason: &str,
    mut pass: F,
) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for attempt in 1..=attempts {
        if pass().await {
            return true;
        }
        if attempt < attempts {
            log::info!(
                "[llm] warm ({reason}): attempt {attempt}/{attempts} did not complete (contended/unreachable), retrying"
            );
            tokio::time::sleep(delay).await;
        }
    }
    log::warn!(
        "[llm] warm ({reason}): gave up after {attempts} attempts; the 60s periodic loop will keep retrying"
    );
    false
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
            if mgr.is_shutting_down() {
                return;
            }
            // Boot pass: pre-load enabled models so the FIRST dictation is
            // warm. Retried on a short cadence (not just the 60s tick) so a
            // model that Ollama can't serve YET — because the app just
            // auto-spawned `ollama serve` and it is still coming up — gets
            // warmed within seconds of the daemon answering, not up to a
            // minute later.
            log::info!("[llm] warmup loop: boot pass starting");
            let mut booted = mgr.warm_enabled_models_with_retry("boot").await;
            log::info!(
                "[llm] warmup loop: boot pass {}",
                if booted {
                    "complete"
                } else {
                    "incomplete (will retry on tick)"
                }
            );
            loop {
                tokio::time::sleep(OLLAMA_WARMUP_INTERVAL).await;
                if mgr.is_shutting_down() {
                    log::info!("[llm] warmup loop: stopping for app shutdown");
                    return;
                }
                // After boot, re-warm on a timer ONLY under the "never unload"
                // policy (self-heal: Ollama restarted or evicted the model out
                // from under us). Every chat/warmup request already carries the
                // keep_alive mapped from the shared unload timeout, so a finite
                // policy (2m/15m/…) counts down from the LAST REAL USE on its
                // own — a periodic re-warm would reset that countdown forever
                // and the model would never unload, violating the setting.
                if !booted || mgr.ollama_keep_alive_refresh_enabled() {
                    booted = mgr.warm_enabled_models().await || booted;
                }
            }
        });
    }

    /// Run warmup passes until one completes against a reachable endpoint (or
    /// there is nothing to warm), retrying on the short trigger cadence rather
    /// than waiting out the 60s periodic tick. Used by the boot pass and by the
    /// on-toggle/on-select trigger ([`crate::winstt::commands::settings::runtime::warm_llm_models_async`]),
    /// the two moments where the user expects the model to be warm SOON. A
    /// single pass returns `false` when it lost the pass-claim to an in-flight
    /// pass or Ollama was momentarily unreachable — both transient, both worth
    /// a quick retry. `reason` is a short tag for the logs (`"boot"` / `"trigger"`).
    pub async fn warm_enabled_models_with_retry(&self, reason: &str) -> bool {
        retry_until_complete(
            OLLAMA_WARM_TRIGGER_ATTEMPTS,
            OLLAMA_WARM_TRIGGER_RETRY_DELAY,
            reason,
            || self.warm_enabled_models(),
        )
        .await
    }

    /// Run one warmup pass over the enabled Ollama models. Returns `true` when
    /// the pass ran to completion against a reachable endpoint (or had nothing
    /// to do), `false` when it should be retried (another pass was in flight,
    /// or Ollama was unreachable).
    pub async fn warm_enabled_models(&self) -> bool {
        if self.is_shutting_down() {
            log::info!("[llm] warm pass: skipped (app shutdown in progress)");
            return true;
        }
        let Some(_pass) = self.lifecycle.try_claim(LLM_WARMUP_PASS_KEY) else {
            log::info!("[llm] warm pass: skipped (another warmup pass is in flight)");
            return false;
        };

        let settings = read_settings_raw(&self.app);
        let endpoint = settings.llm.endpoint.clone();
        let models = enabled_ollama_models(&settings);
        if models.is_empty() {
            log::info!("[llm] warm pass: no enabled Ollama models to warm; evicting stale");
            self.evict_stale_warmed_models(&endpoint, &[]).await;
            self.clear_warmup_status();
            return true;
        }
        log::info!("[llm] warm pass: endpoint='{endpoint}' models={models:?}");

        // NOTE: do NOT cancel in-flight requests here. The only cancellable LLM
        // work is user dictation/transform (warmup itself uses `/api/generate`
        // and never registers a cancel id), and this pass fires on a periodic
        // timer, on settings changes, and after a pull — none of which should
        // abort a dictation the user just spoke. A cancelled chat returns a
        // partial structured-output fragment that then gets pasted as garbage
        // (`{` / `{"text`). Warmup only warms the active model and evicts STALE
        // ones (never the active model), so it cannot conflict with a live
        // dictation; let that dictation finish.
        let (reachable, ollama_installed) = self.ensure_ollama_reachable(&endpoint).await;
        if !reachable {
            log::warn!(
                "[llm] warm pass: Ollama UNREACHABLE at '{endpoint}' (installed={ollama_installed}); models {models:?} left cold this pass"
            );
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
            return false;
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

        let any_retryable = results
            .iter()
            .any(|r| Self::warmup_outcome_is_retryable(&r.outcome));
        log::info!(
            "[llm] warm pass: done, outcomes={:?}{}",
            results
                .iter()
                .map(|r| (&r.model, &r.outcome))
                .collect::<Vec<_>>(),
            if any_retryable {
                " (has retryable failures -> caller may retry)"
            } else {
                ""
            }
        );
        self.publish_warmup_status(LlmWarmupStatus {
            endpoint,
            in_progress: false,
            models: results,
            ollama_installed,
            reachable: true,
            timestamp: warmup_timestamp(),
        });
        // Report a retryable per-model failure (transient transport / non-404
        // HTTP) as "not complete" so the trigger/boot retry loop re-attempts the
        // pass instead of leaving the model cold until the 60s tick.
        !any_retryable
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
            log::warn!("[llm] Ollama not reachable and no `ollama` executable found to auto-start");
            return (false, detected.installed);
        };
        log::info!("[llm] Ollama not reachable at '{endpoint}'; auto-starting `ollama serve` and waiting up to {OLLAMA_BOOT_WAIT:?}");
        if let Err(err) = crate::winstt::commands::llm::spawn_ollama_serve(&path) {
            log::warn!("[llm] Ollama auto-start failed: {err}");
            return (false, true);
        }
        let up = self.wait_for_ollama(endpoint, OLLAMA_BOOT_WAIT).await;
        log::info!("[llm] Ollama auto-start: reachable={up} after waiting");
        (up, true)
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
        let started = Instant::now();
        self.ollama
            .unload_model(endpoint, model, OLLAMA_EVICT_TIMEOUT)
            .await;
        model_watchdog::untrack_ollama_model(endpoint, model);
        crate::log_model_duration(&format!("ollama unload '{model}'"), started);
    }

    /// Unload EVERY Ollama model this process warmed at the configured endpoint
    /// (`keep_alive: 0`) and clear the warm tracking, freeing the model from VRAM
    /// immediately instead of waiting out the keep-alive timer (or forever under
    /// the "never unload" policy). Used on graceful app exit and when LLM
    /// post-processing is fully disabled.
    ///
    /// Loopback-only: a remote Ollama the user points WinSTT at is theirs to
    /// manage, so we never evict models on it. Only warm-tracked models are
    /// touched — every model WinSTT loads (warmup AND chat) is `mark_warm`ed, so
    /// this frees exactly what WinSTT put there and nothing the user loaded
    /// independently. `per_model_timeout` bounds each request so the exit path
    /// stays inside the shutdown watchdog.
    pub async fn unload_warmed_ollama_models(&self, per_model_timeout: Duration) {
        let settings = read_settings_raw(&self.app);
        let endpoint = settings.llm.endpoint.clone();
        if !is_loopback_ollama_endpoint(&endpoint) {
            return;
        }
        let prefix = llm_endpoint_prefix(&endpoint);
        let models: Vec<String> = self
            .lifecycle
            .warm_keys()
            .into_iter()
            .filter(|key| key.starts_with(&prefix))
            .filter_map(|key| llm_model_from_key(&key, &endpoint).map(str::to_string))
            .collect();
        for model in models {
            self.ollama
                .unload_model(&endpoint, &model, per_model_timeout)
                .await;
            model_watchdog::untrack_ollama_model(&endpoint, &model);
            self.lifecycle.clear_warm(&llm_model_key(&endpoint, &model));
            log::info!("[llm] unloaded Ollama model '{model}' from VRAM");
        }
    }

    /// Evict specific Ollama models from VRAM by name (`keep_alive: 0`) and clear
    /// any warm tracking for them. Unlike [`Self::unload_warmed_ollama_models`]
    /// this does NOT depend on the warm-tracking set — it unloads exactly the
    /// models the caller names, so a model resident from a prior run (or one this
    /// build never warm-tracked) is still freed when a feature stops using it.
    /// Loopback-only: a remote Ollama the user points WinSTT at is theirs to manage.
    pub async fn unload_ollama_models(&self, models: &[String], per_model_timeout: Duration) {
        let settings = read_settings_raw(&self.app);
        let endpoint = settings.llm.endpoint.clone();
        log::info!(
            "[llm] unload_ollama_models: endpoint='{endpoint}' loopback={} models={models:?}",
            is_loopback_ollama_endpoint(&endpoint)
        );
        if !is_loopback_ollama_endpoint(&endpoint) {
            return;
        }
        for model in models {
            if model.trim().is_empty() {
                continue;
            }
            self.ollama
                .unload_model(&endpoint, model, per_model_timeout)
                .await;
            model_watchdog::untrack_ollama_model(&endpoint, model);
            self.lifecycle.clear_warm(&llm_model_key(&endpoint, model));
            log::info!("[llm] unloaded Ollama model '{model}' from VRAM (feature disabled)");
        }
    }

    pub(super) fn mark_ollama_model_warm(&self, endpoint: &str, model: &str) {
        if !model.trim().is_empty() {
            self.lifecycle.mark_warm(llm_model_key(endpoint, model));
            model_watchdog::track_ollama_model(endpoint, model);
        }
    }

    /// Record that an Ollama CHAT just failed to load the model (the runner
    /// crashed — `HTTP 500 … terminated`, or stalled with no output). Lets the
    /// next dictation/transform skip the doomed call instead of paying the full
    /// ~16-28s crash again. Same backoff the warmup uses.
    pub(super) fn mark_ollama_model_crashed(&self, endpoint: &str, model: &str) {
        if !model.trim().is_empty() {
            self.lifecycle
                .mark_load_failed(llm_model_key(endpoint, model));
        }
    }

    /// True iff this model crashed/failed to load within the backoff window — the
    /// caller should SKIP post-processing and fail soft to the original text
    /// INSTANTLY rather than re-triggering a guaranteed ~16s crash. After the
    /// window it tries once more (in case VRAM was freed); a success clears it.
    pub(super) fn ollama_model_recently_crashed(&self, endpoint: &str, model: &str) -> bool {
        !model.trim().is_empty()
            && self
                .lifecycle
                .is_load_failed_within(&llm_model_key(endpoint, model), OLLAMA_LOAD_FAIL_BACKOFF)
    }

    async fn warmup_ollama_model(
        &self,
        endpoint: &str,
        model: &str,
        keep_alive: serde_json::Value,
    ) -> LlmWarmupModelStatus {
        if self.is_shutting_down() {
            return LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: LlmWarmupOutcome::Skipped,
                error_body: None,
            };
        }
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
            log::info!("[llm] warm '{model}': already warm within {OLLAMA_RECENT_WARM_SKIP:?}, skipping load");
            return LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: LlmWarmupOutcome::Ok,
                error_body: None,
            };
        }
        // Back off after a recent load CRASH (e.g. the runner died because the
        // model can't fit in VRAM): re-warming it every 60s would just churn the
        // GPU with repeated ~28s crashing loads. A real dictation still tries it
        // on demand; a success (here or there) clears the marker.
        if self
            .lifecycle
            .is_load_failed_within(&model_key, OLLAMA_LOAD_FAIL_BACKOFF)
        {
            log::warn!(
                "[llm] warm '{model}': skipping — load failed within {OLLAMA_LOAD_FAIL_BACKOFF:?} (likely won't fit in VRAM); backing off to avoid GPU churn"
            );
            return LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: LlmWarmupOutcome::LoadFailed,
                error_body: None,
            };
        }
        let Some(_claim) = self.lifecycle.try_claim(model_key.clone()) else {
            log::info!("[llm] warm '{model}': a load for this model is already in flight");
            return LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: LlmWarmupOutcome::Loading,
                error_body: None,
            };
        };

        log::info!("[llm] warm '{model}': loading into VRAM (keep_alive={keep_alive})");
        let started = Instant::now();
        match self
            .ollama
            .warmup_model(endpoint, model, keep_alive, OLLAMA_WARMUP_TIMEOUT)
            .await
        {
            OllamaLoadResult::Ok => {
                self.mark_ollama_model_warm(endpoint, model);
                log::info!(
                    "[llm] warm '{model}': OK, resident in {}ms",
                    started.elapsed().as_millis()
                );
                crate::log_model_duration(&format!("ollama warmup '{model}'"), started);
                LlmWarmupModelStatus {
                    model: model.to_string(),
                    outcome: LlmWarmupOutcome::Ok,
                    error_body: None,
                }
            }
            OllamaLoadResult::Transport(err) => {
                log::warn!(
                    "[llm] warm '{model}': transport error after {}ms (retryable): {err}",
                    started.elapsed().as_millis()
                );
                crate::log_model_duration(&format!("ollama warmup unreachable '{model}'"), started);
                LlmWarmupModelStatus {
                    model: model.to_string(),
                    outcome: LlmWarmupOutcome::Unreachable,
                    error_body: Some(err),
                }
            }
            OllamaLoadResult::Http { status, body } => {
                log::warn!(
                    "[llm] warm '{model}': HTTP {status} after {}ms: {body}",
                    started.elapsed().as_millis()
                );
                crate::log_model_duration(&format!("ollama warmup failed '{model}'"), started);
                // Remember the failure so the periodic loop backs off (a crashing
                // VRAM-overflow load returns HTTP 500 here; a missing model 404s).
                self.lifecycle.mark_load_failed(model_key);
                LlmWarmupModelStatus {
                    model: model.to_string(),
                    outcome: if status == 404 {
                        LlmWarmupOutcome::ModelNotFound
                    } else {
                        LlmWarmupOutcome::LoadFailed
                    },
                    error_body: if body.is_empty() { None } else { Some(body) },
                }
            }
        }
    }

    /// A per-model warmup outcome that the short on-trigger/boot retry could
    /// plausibly fix: ONLY a transport failure (`Unreachable`) — Ollama still
    /// starting up, or a momentary connection blip — which clears in a second or
    /// two. An HTTP error (`LoadFailed`, e.g. the runner crashing because the
    /// model does not fit in VRAM: `GGML_SCHED_MAX_SPLIT_INPUTS` / process
    /// terminated) will NOT recover on an immediate retry — hammering it 8× just
    /// churns the GPU with ~28s crashing loads back-to-back. Let those (and
    /// `ModelNotFound`/`Ok`/`Skipped`/`Loading`) end the pass; the 60s periodic
    /// loop still re-attempts later, so a genuinely-transient HTTP blip recovers
    /// without the immediate storm.
    fn warmup_outcome_is_retryable(outcome: &LlmWarmupOutcome) -> bool {
        matches!(outcome, LlmWarmupOutcome::Unreachable)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    // A warm pass that fails (`false`) the first `fail_first` times, then
    // succeeds (`true`). Records how many times it was called.
    fn flaky_pass(
        fail_first: u32,
        calls: &Cell<u32>,
    ) -> impl Fn() -> std::future::Ready<bool> + '_ {
        move || {
            let n = calls.get() + 1;
            calls.set(n);
            std::future::ready(n > fail_first)
        }
    }

    #[tokio::test]
    async fn retry_stops_at_first_success() {
        // Two transient failures (lost claim / momentary unreachable), then OK:
        // the model warms on attempt 3 instead of waiting out the 60s tick.
        let calls = Cell::new(0);
        let ok = retry_until_complete(8, Duration::ZERO, "test", flaky_pass(2, &calls)).await;
        assert!(ok, "should report success once a pass completes");
        assert_eq!(calls.get(), 3, "stops the instant a pass succeeds");
    }

    #[tokio::test]
    async fn retry_succeeds_on_first_try_without_extra_passes() {
        let calls = Cell::new(0);
        let ok = retry_until_complete(8, Duration::ZERO, "test", flaky_pass(0, &calls)).await;
        assert!(ok);
        assert_eq!(calls.get(), 1, "a warm Ollama needs exactly one pass");
    }

    #[tokio::test]
    async fn retry_is_bounded_when_every_pass_fails() {
        // Ollama never comes back within the trigger budget: give up after
        // exactly `attempts` passes and let the 60s periodic loop take over.
        let calls = Cell::new(0);
        let ok =
            retry_until_complete(5, Duration::ZERO, "test", flaky_pass(u32::MAX, &calls)).await;
        assert!(!ok, "reports failure after exhausting the attempt budget");
        assert_eq!(calls.get(), 5, "never exceeds the attempt budget");
    }

    #[test]
    fn only_transport_failure_is_retryable() {
        // ONLY a transport blip (Ollama still starting / momentary connection
        // loss) is worth the immediate short retry...
        assert!(LlmManager::warmup_outcome_is_retryable(
            &LlmWarmupOutcome::Unreachable
        ));
        // ...an HTTP error (incl. the runner CRASHING because the model can't fit
        // in VRAM) must NOT be hammered — retrying churns the GPU with repeated
        // ~28s crashing loads; the 60s periodic loop re-attempts instead. A
        // successful/in-flight/skipped load and a missing model (404) likewise
        // don't spin the retry loop.
        for terminal in [
            LlmWarmupOutcome::LoadFailed,
            LlmWarmupOutcome::Ok,
            LlmWarmupOutcome::Loading,
            LlmWarmupOutcome::Skipped,
            LlmWarmupOutcome::ModelNotFound,
        ] {
            assert!(
                !LlmManager::warmup_outcome_is_retryable(&terminal),
                "{terminal:?} should not trigger an immediate retry"
            );
        }
    }
}

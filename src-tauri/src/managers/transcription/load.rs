//! Model load / unload / warmup / swap lifecycle.
//!
//! This file only adds an `impl TranscriptionManager` block on the type defined in the
//! module root; all shared free helpers / types / guards live in [`super`].

use super::{
    is_degenerate_decode_error, LoadedEngine, LoadingGuard, ModelStateEvent, TranscriptionManager,
    WarmingGuard,
};
use crate::settings::{get_settings, ModelUnloadTimeout};
use crate::winstt::stt::BackendRoute;
use anyhow::Result;
use log::{debug, error, info, warn};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::Ordering;
use tauri::Emitter;

impl TranscriptionManager {
    /// Atomically check whether a model load is in progress and, if not, mark
    /// one as starting. Returns a [`LoadingGuard`] whose [`Drop`] impl will
    /// clear the flag and wake waiters. Returns `None` if a load is already in
    /// progress.
    pub fn try_start_loading(&self) -> Option<LoadingGuard> {
        let mut is_loading = self.lock_is_loading();
        if *is_loading {
            return None;
        }
        *is_loading = true;
        Some(LoadingGuard {
            is_loading: self.is_loading.clone(),
            loading_condvar: self.loading_condvar.clone(),
        })
    }

    pub fn unload_model(&self) -> Result<()> {
        let unload_start = std::time::Instant::now();
        debug!("Starting to unload model");

        let mut old_engine = {
            let mut engine = self.lock_engine();
            engine.take()
        };
        if let Some(engine) = old_engine.as_mut() {
            engine.shutdown();
        }
        {
            let mut current_model = self.lock_current_model();
            *current_model = None;
        }
        self.clear_warmed_model();

        // Emit unloaded event
        let _ = self.app_handle.emit(
            crate::winstt::commands::events::names::MODEL_STATE_CHANGED,
            ModelStateEvent {
                event_type: "unloaded".to_string(),
                model_id: None,
                model_name: None,
                error: None,
            },
        );

        let unload_duration = unload_start.elapsed();
        debug!(
            "Model unloaded manually (took {}ms)",
            unload_duration.as_millis()
        );
        Ok(())
    }

    /// Unloads the model immediately if the setting is enabled and the model is loaded
    pub fn maybe_unload_immediately(&self, context: &str) {
        if self.listen_mode_forces_model_resident() {
            self.touch_activity();
            return;
        }
        let settings = get_settings(&self.app_handle);
        if settings.model_unload_timeout == ModelUnloadTimeout::Immediately
            && self.is_model_loaded()
        {
            info!("Immediately unloading model after {}", context);
            if let Err(e) = self.unload_model() {
                warn!("Failed to immediately unload model: {}", e);
            }
        }
    }

    /// The model the user actually selected. The WinSTT picker (`winstt_settings.model.model`)
    /// is the source of truth.
    pub(super) fn desired_model_id(&self) -> String {
        self.backend.selected_model_id(&self.app_handle)
    }

    /// Reconcile the loaded engine to the user's selected model. Loads it if nothing is loaded
    /// OR swaps if a *different* model is loaded (the previous early-return-if-loaded blocked
    /// model switching). WinSTT-catalog ids load through the unified ort engine;
    /// unknown ids are rejected.
    pub fn initiate_model_load(&self) {
        // Cheap pre-check WITHOUT claiming the loading flag: nothing to do if we're already on
        // the selected model. (try_start_loading below is the real, atomic gate.)
        let desired = self.desired_model_id();
        if self.is_model_loaded() && self.get_current_model().as_deref() == Some(desired.as_str()) {
            return; // already on the selected model
        }
        // PANIC-SAFE claim of the loading flag. The `LoadingGuard` is MOVED into the worker
        // thread so its Drop clears `is_loading` + wakes condvar waiters on EVERY exit of the
        // thread — including a panic in `dispatch_load`. (See `load_model_blocking` for why a
        // stuck `is_loading` permanently wedges the PTT pipeline.)
        let guard = match self.try_start_loading() {
            Some(g) => g,
            None => return, // a load is already in flight; it picks up the latest selection
        };
        let self_clone = self.clone();
        std::thread::spawn(move || {
            let _guard = guard; // RAII: clears is_loading + notifies on return OR panic.
            let desired = self_clone.desired_model_id();
            // Failure-atomic: dispatch_load does NOT unload up front — a failed resolve/build
            // leaves the previous engine resident (re-emitting loading_completed for it). Wrap in
            // catch_unwind so a build panic can't escape and abort the thread before the guard's
            // Drop runs (it would still run on unwind, but this keeps the log clean + explicit).
            let _ = catch_unwind(AssertUnwindSafe(|| {
                if let Err(e) = self_clone.dispatch_load(&desired, None) {
                    error!("Failed to load model '{}': {}", desired, e);
                }
            }));
        });
    }

    /// Dispatch a load to the right backend by id namespace, FAILURE-ATOMICALLY: never unload the
    /// currently-resident engine up front. Cloud ids have no local engine (mark current + free any
    /// local engine, since the switch to cloud can't fail). WinSTT-catalog ids go through
    /// `load_winstt_model`, which resolves the file set OFFLINE first and only unloads the old
    /// engine once that succeeds (the Windows DLL race forbids two live ort sessions). On any
    /// error, the previously-loaded model is still resident, so we re-emit
    /// `loading_completed` for it so the picker chip clears on a model the user can still dictate with.
    fn dispatch_load(&self, model_id: &str, quantization_override: Option<&str>) -> Result<()> {
        // Snapshot the still-resident model BEFORE attempting the swap, for the rollback re-emit.
        let previous = self.get_current_model();

        let result = match self.backend.route_of(model_id) {
            BackendRoute::Cloud => {
                // Cloud STT id (provider:model): no local engine. Free any resident local engine
                // and mark the cloud id current + ready so transcribe() routes to the backend's
                // cloud method.
                if self.is_model_loaded() {
                    let _ = self.unload_model();
                }
                {
                    let mut current = self.lock_current_model();
                    *current = Some(model_id.to_string());
                }
                self.touch_activity();
                Ok(())
            }
            BackendRoute::Catalog => self.load_winstt_model(model_id, quantization_override),
            BackendRoute::Unsupported => Err(anyhow::anyhow!(
                "model '{}' is not in the WinSTT catalog",
                model_id
            )),
        };

        if result.is_err() {
            self.reemit_resident_after_failed_swap(previous.as_deref());
        }
        result
    }

    /// After a FAILED swap, re-emit `loading_completed` for the model still resident (if any) so
    /// the renderer's picker clears its "Switching…" chip on a model the user can still dictate
    /// with — rather than being stuck on the failed target. No-op when nothing is loaded.
    fn reemit_resident_after_failed_swap(&self, previous: Option<&str>) {
        if !self.is_model_loaded() {
            return; // genuinely nothing resident (e.g. cold first-load failure)
        }
        let model_id = match self
            .get_current_model()
            .or_else(|| previous.map(str::to_string))
        {
            Some(id) => id,
            None => return,
        };
        // Best-effort display name (catalog → display, else the raw id).
        let model_name = self.backend.display_name_for(&model_id);
        let _ = self.app_handle.emit(
            crate::winstt::commands::events::names::MODEL_STATE_CHANGED,
            ModelStateEvent {
                event_type: "loading_completed".to_string(),
                model_id: Some(model_id),
                model_name: Some(model_name),
                error: None,
            },
        );
    }

    /// Synchronous load to a SPECIFIC `model_id` (the picker's choice, threaded through from
    /// `set_winstt_model` → `perform_model_swap`) that RETURNS the real load error so the swap
    /// orchestrator can emit `stt:model-swap-failed` (rollback + toast) instead of swallowing it.
    /// Mirrors the legacy `switch_active_model(model_id)` + the body of `initiate_model_load`, but
    /// blocking and id-EXPLICIT — it must NOT re-read settings (the renderer's persist of
    /// `model.model` is debounced, so a re-read would load the stale/default "tiny" and "succeed").
    /// Runs on the swap orchestrator's own thread, so it never blocks the Tauri command thread.
    pub fn load_model_blocking(&self, model_id: &str) -> std::result::Result<(), String> {
        self.load_model_blocking_inner(model_id, false, None)
    }

    pub fn load_model_blocking_with_quantization(
        &self,
        model_id: &str,
        quantization_override: Option<&str>,
    ) -> std::result::Result<(), String> {
        self.load_model_blocking_inner(model_id, false, quantization_override)
    }

    /// Same as [`Self::load_model_blocking`], but intentionally rebuilds even when `model_id` is
    /// already current. Used for same-model load-input changes such as quantization/device swaps.
    pub fn reload_model_blocking(&self, model_id: &str) -> std::result::Result<(), String> {
        self.load_model_blocking_inner(model_id, true, None)
    }

    fn load_model_blocking_inner(
        &self,
        model_id: &str,
        force_reload: bool,
        quantization_override: Option<&str>,
    ) -> std::result::Result<(), String> {
        let model_id = model_id.trim();
        if model_id.is_empty() {
            return Err("model id is empty".to_string());
        }

        loop {
            if !force_reload && self.is_model_ready_for(model_id) {
                self.spawn_warmup_if_needed(model_id);
                return Ok(());
            }

            // PANIC-SAFE: claim the loading flag through the RAII `LoadingGuard`. Its Drop clears
            // `is_loading` and wakes any `transcribe()` blocked on the load condvar on EVERY exit —
            // normal return, early return, OR a panic in `dispatch_load`.
            let guard = match self.try_start_loading() {
                Some(g) => g,
                None => {
                    // Another swap/warm path is already doing the expensive work. Wait for it
                    // instead of returning a false "already loading" failure; if it loaded our
                    // target, reuse the warmed/loaded engine, otherwise claim the slot and try.
                    self.wait_for_loading_to_finish();
                    continue;
                }
            };

            // FAILURE-ATOMIC: dispatch_load never unloads the resident engine up front — a failed
            // resolve/build leaves the previous model dictatable (and re-emits loading_completed),
            // instead of the old unload-first path that left NOTHING loaded on a network blip.
            // catch_unwind turns a build panic into an Err so the swap orchestrator can emit
            // `model-swap-failed` (rollback + toast) instead of the worker thread dying silently.
            let outcome: Result<()> = match catch_unwind(AssertUnwindSafe(|| {
                self.dispatch_load(model_id, quantization_override)
            })) {
                Ok(r) => r,
                Err(_) => Err(anyhow::anyhow!(
                    "model load panicked while building the engine"
                )),
            };
            // Clear `is_loading` (and wake waiters) BEFORE spawning the warmup so the warm decode's
            // own load-condvar wait passes immediately instead of blocking on our own guard.
            drop(guard);
            // Warm the freshly-loaded engine so the first post-swap decode isn't cold (DML kernel
            // JIT), but detach it so the swap completes on LOAD. The warm-state guard makes this
            // idempotent when settings/save and explicit swap paths both request warmup.
            if outcome.is_ok() {
                self.spawn_warmup_if_needed(model_id);
            }
            return outcome.map_err(|e| {
                error!("Failed to load model '{model_id}': {e}");
                e.to_string()
            });
        }
    }

    fn spawn_warmup_if_needed(&self, model_id: &str) {
        if self.backend.route_of(model_id) == BackendRoute::Cloud || self.is_model_warm(model_id) {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || me.warmup());
    }

    /// Eagerly compile the loaded engine's kernels with a dummy 1s-silence decode so the FIRST
    /// real PTT decode is WARM — no cold DirectML kernel JIT serialized on the release path (the
    /// dominant cause of the port feeling ~10x slower than the reference on the first dictation). Mirrors
    /// the reference server's `RecorderService.warmup` (decodes `np.zeros(16000)` at boot). The
    /// WinSTT ort/DirectML engine pays cold-JIT, so we warm it best-effort; a warmup failure must
    /// never break dictation.
    pub fn warmup(&self) {
        // Wait out any in-flight LOAD (we must not warm a half-built engine), but do NOT hold
        // `is_loading` for the warm decode — that was the bug: a real dictation that raced in
        // WAITED on transcribe()'s loading condvar even though the engine was fully loaded and
        // ready, serializing the user's decode behind a cold ~1s warmup. Instead we only set the
        // separate `warming` flag and yield the engine to any real decode via `try_lock`.
        self.wait_for_loading_to_finish();
        let Some(model_id) = self.get_current_model() else {
            return;
        };
        if self.is_model_warm(&model_id) {
            debug!("[stt] warmup skipped — model '{model_id}' is already warm");
            return;
        }
        if !self.is_model_loaded() {
            return; // cloud id, or load failed — nothing local to warm
        }

        if self
            .warming
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            debug!("[stt] warmup skipped — another warmup is already running");
            return;
        }
        // Clear `warming` on EVERY exit path (early return / panic) via RAII.
        let warming_guard = WarmingGuard(&self.warming);

        // PREEMPTABLE: grab the engine with `try_lock`, NOT a blocking `lock()`. If a real
        // transcribe() already holds it, the warmup yields (the user's decode IS the warmup) —
        // it never blocks the dictation path. Hold the lock for the dummy decode itself; a real
        // decode that arrives after we grab the lock waits only on the engine mutex (not the
        // load condvar), and there's nothing to gain by warming twice.
        let mut engine_guard = match self.engine.try_lock() {
            Ok(g) => g,
            Err(std::sync::TryLockError::WouldBlock) => {
                debug!("[stt] warmup yielded — a real decode is using the engine");
                return;
            }
            Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
        };
        // Decode dummy silence DIRECTLY (the backend's warmup bypasses the RMS silence-gate that
        // would reject all-zeros). Keep the engine IN the guard — a panic is caught and the engine
        // is left resident (matching transcribe()'s catch_unwind discipline; only differs in that
        // we don't take() it out). The WinSTT-specific dummy-decode body lives in the backend
        // (audit #14); this core owns only the `try_lock` preemption + `catch_unwind`.
        let warmup_result: std::result::Result<(), anyhow::Error> =
            if let Some(LoadedEngine::Winstt(e)) = engine_guard.as_mut() {
                let backend = self.backend.clone();
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    backend.warmup(e.as_mut())
                })) {
                    Ok(result) => result,
                    Err(_) => Err(anyhow::anyhow!("WinSTT warmup panicked")),
                }
            } else {
                Ok(())
            };
        drop(engine_guard);

        if let Err(err) = warmup_result {
            let degenerate = is_degenerate_decode_error(&err);
            warn!("[stt] engine warmup failed for '{model_id}': {err}");
            if degenerate {
                warn!(
                    "[stt] recycling '{model_id}' after DirectML degenerate decode during warmup"
                );
                drop(warming_guard);
                if let Err(reload_err) = self.load_model_blocking_inner(&model_id, true, None) {
                    error!(
                        "[stt] CPU fallback reload failed for '{model_id}' after degenerate warmup: {reload_err}"
                    );
                }
            }
            return;
        }

        self.mark_model_warmed_if_current(&model_id);
        self.touch_activity();
        log::info!("[stt] engine warmup complete for '{model_id}'");
    }

    /// Load a WinSTT-catalog model through the unified ort-ONNX engine (the proven STT spike
    /// path). The WinSTT-specific work — catalog resolution, effective-quant + provider-list
    /// policy, the offline HF file-set resolve, and the engine build — is owned by the
    /// [`SttBackend`] (audit #14). This core keeps ONLY the generic engine-lifecycle
    /// orchestration: the `model-state-changed` events, the failure-atomic unload-AFTER-resolve
    /// ordering (no two live ORT sessions), and installing the built engine into the mutex.
    ///
    /// TWO-PHASE (failure-atomic): `resolve_catalog` resolves the file set OFFLINE without
    /// building any ORT session or touching the resident engine. ONLY once that succeeds do we
    /// free the old engine (the Windows DLL race forbids two live ort sessions) and `build_resolved`
    /// the new one. A failed resolve returns `Err` with the old engine STILL RESIDENT — the caller
    /// re-emits `loading_completed` for it so the picker chip clears on a model the user can still
    /// dictate with.
    fn load_winstt_model(&self, model_id: &str, quantization_override: Option<&str>) -> Result<()> {
        let load_start = std::time::Instant::now();

        // Best-effort display name (catalog → display, else raw id) for the events. The backend's
        // `resolve_catalog`/`build_resolved` return the authoritative name in the spec, but the
        // `loading_started`/`loading_failed`-on-resolve events fire before/around that, so derive
        // it up front from the same catalog source.
        let display_name = self.backend.display_name_for(model_id);

        let emit_failed = |msg: &str, model_name: &str| {
            let _ = self.app_handle.emit(
                crate::winstt::commands::events::names::MODEL_STATE_CHANGED,
                ModelStateEvent {
                    event_type: "loading_failed".to_string(),
                    model_id: Some(model_id.to_string()),
                    model_name: Some(model_name.to_string()),
                    error: Some(msg.to_string()),
                },
            );
        };

        // emit loading_started (parity with the legacy path's event surface) — BEFORE the resolve,
        // matching the original ordering so the picker chip shows "Switching…" immediately.
        let _ = self.app_handle.emit(
            crate::winstt::commands::events::names::MODEL_STATE_CHANGED,
            ModelStateEvent {
                event_type: "loading_started".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: Some(display_name.clone()),
                error: None,
            },
        );

        // PHASE 1 — offline resolve (no ORT session, leaves the resident engine untouched). On
        // failure the old engine is still resident; emit loading_failed with the best-effort name.
        let spec =
            match self
                .backend
                .resolve_catalog(&self.app_handle, model_id, quantization_override)
            {
                Ok(spec) => spec,
                Err(e) => {
                    let msg = e.to_string();
                    emit_failed(&msg, &display_name);
                    return Err(e);
                }
            };

        // FAILURE-ATOMIC SWAP: now that the file set is verified present on disk (resolve
        // succeeded), the build is essentially guaranteed — so it's safe to free the OLD engine's
        // ORT sessions HERE. We CANNOT build the new one first (the Windows DLL race forbids two
        // live ort sessions). If resolve had failed we'd have returned above with the old engine
        // still resident.
        if self.is_model_loaded() {
            let _ = self.unload_model();
        }

        // PHASE 2 — build the engine from the resolved spec.
        let (engine, display_name) = match self.backend.build_resolved(spec) {
            Ok(built) => built,
            Err(e) => {
                let msg = e.to_string();
                emit_failed(&msg, &display_name);
                return Err(e);
            }
        };

        self.clear_warmed_model();
        {
            let mut guard = self.lock_engine();
            *guard = Some(LoadedEngine::Winstt(engine));
        }
        {
            let mut current = self.lock_current_model();
            *current = Some(model_id.to_string());
        }
        self.touch_activity();

        let _ = self.app_handle.emit(
            crate::winstt::commands::events::names::MODEL_STATE_CHANGED,
            ModelStateEvent {
                event_type: "loading_completed".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: Some(display_name),
                error: None,
            },
        );
        info!(
            "Loaded WinSTT model '{}' in {}ms",
            model_id,
            load_start.elapsed().as_millis()
        );
        Ok(())
    }
}

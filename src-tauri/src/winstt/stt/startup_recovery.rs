// Startup reconciliation of the PERSISTED STT selection against the weights actually on disk.
//
// WHY THIS EXISTS
// ---------------
// `winstt_settings` is portable: it travels with a portable install, an exported settings file, a
// roamed profile, or simply a reinstall on a fresh Windows box. The HuggingFace model cache does
// NOT travel with it. So the app can (and did — the reported bug) boot on a machine whose settings
// say "NVIDIA Parakeet, int8" while the cache holds nothing at all. Everything downstream then
// behaves as if that model were installed: the picker shows it selected, the runtime chip names it,
// and the first dictation fails deep in `resolver::resolve` with a "missing weight file" error
// (the loader deliberately refuses to silently pull multi-GB weights on the load path).
//
// The renderer HAS a stale-selection fallback (`useStaleModelFallback`), but it only runs while the
// Settings window is mounted, and by design it rewrites a valid-but-uncached selection ONLY when the
// factory default is itself cached — on a machine with NO models it leaves the selection alone
// ("it can download on demand"). That is exactly the stranded state.
//
// WHAT THIS DOES (once, on the startup path, before anything schedules a model load or a window)
// ---------------------------------------------------------------------------------------------
//   1. The selection is a CLOUD `provider:model` id → nothing local to verify, leave it alone.
//   2. The selected local model has a fully-cached precision → intact, the common path, one
//      scoped cache probe and we're done.
//   3. It doesn't → probe the whole catalog and AUTO-SWITCH to a model that IS on disk
//      (deterministic policy, shared with the offline cloud salvage: the factory default when it
//      is cached, else the smallest fully-cached decodable model). The precision is pinned to the
//      one actually cached so the switch target can't strand the user the same way.
//   4. Nothing decodable is on disk at all → the app has no usable STT at all, so re-run the
//      first-run wizard (`onboarding::set_model_setup_required`), whose model step cannot be
//      advanced until at least one model finishes downloading. The selection is reset to the
//      factory default first so the wizard offers the small starter download rather than the
//      multi-GB model the user can no longer load — UNLESS there is a partial download on disk for
//      the current selection, in which case it is kept so the wizard offers "Resume" over the bytes
//      already fetched.
//
// COST: step 2 probes ONLY the selected model (one `scan_cache` fs walk + the external-data verify
// for that one repo — the same walk the loader itself does moments later). The whole-catalog probe
// in step 3 runs only on the miss, which is the already-broken path. We deliberately do NOT go
// through `DownloadManager::cache_snapshot_async` here: its memo is keyed by time alone, so seeding
// it with a one-model probe would make the picker's next whole-catalog call read every OTHER model
// as `not_cached` for the following 2 s.

use std::collections::BTreeMap;

use tauri::AppHandle;

use crate::winstt::catalog::{self, ModelEntry};
use crate::winstt::settings_schema::DEFAULT_STT_MODEL_ID;
use crate::winstt::stt::cache_probe::{self, CacheState, ModelQuantCache, ProbeModel};

/// One locally-complete `(model, precision)` pair — a selection the app can load with ZERO network.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedSelection {
    /// Catalog model id.
    pub model_id: String,
    /// The catalog quant suffix that is cached (`""` = the default fp32 export).
    pub quantization: String,
    /// On-disk bytes of that precision — the tie-break for "smallest usable model".
    pub bytes: u64,
}

/// How the persisted selection stands against the cache.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SelectedState {
    /// At least one published precision is fully cached — the model loads offline.
    Usable,
    /// Bytes on disk but no COMPLETE precision (an interrupted download). Not loadable: the
    /// resolver fails fast on a missing weight rather than silently refetching it.
    Partial,
    /// Nothing on disk — or the id isn't a decodable catalog model at all (stale/renamed id,
    /// a family with no wired Rust engine).
    Missing,
}

/// What startup decided about the persisted selection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SttSelectionRecovery {
    /// Usable as-is (cached locally, or a cloud id with no local weights to check).
    Intact,
    /// The selection was rewritten to a model that IS on disk.
    Switched { from: String, to: CachedSelection },
    /// Nothing decodable is installed — the first-run wizard must run again.
    SetupRequired {
        from: String,
        /// `true` when the selection was reset to the factory default (no partial to resume).
        reset_to_default: bool,
    },
}

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

/// Pick the model to fall back to, from every locally-complete candidate.
///
/// DETERMINISTIC, and identical to the offline cloud-salvage policy in [`super::fallback`]: the
/// factory default (`tiny`) wins outright when it is cached — every automatic fallback in the app
/// resolves to that same target — and only among the non-default candidates does size break the
/// tie (smallest = fastest to load and least likely to blow the user's memory budget). Ties resolve
/// to the first candidate seen; callers feed sorted `BTreeMap` iteration order, so the choice is
/// stable across runs.
pub fn pick_cached_selection(
    candidates: impl IntoIterator<Item = CachedSelection>,
) -> Option<CachedSelection> {
    let mut best_default: Option<CachedSelection> = None;
    let mut best_other: Option<CachedSelection> = None;
    for candidate in candidates {
        let is_default = catalog::canonical_model_id(&candidate.model_id) == DEFAULT_STT_MODEL_ID;
        let slot = if is_default {
            &mut best_default
        } else {
            &mut best_other
        };
        if slot
            .as_ref()
            .is_none_or(|current| candidate.bytes < current.bytes)
        {
            *slot = Some(candidate);
        }
    }
    best_default.or(best_other)
}

/// The pure decision, split out so the whole policy is testable without an `AppHandle` or a cache.
pub(crate) fn decide_recovery(
    selected: &str,
    state: SelectedState,
    candidates: impl IntoIterator<Item = CachedSelection>,
) -> SttSelectionRecovery {
    if state == SelectedState::Usable {
        return SttSelectionRecovery::Intact;
    }
    if let Some(pick) = pick_cached_selection(candidates) {
        return SttSelectionRecovery::Switched {
            from: selected.to_string(),
            to: pick,
        };
    }
    SttSelectionRecovery::SetupRequired {
        from: selected.to_string(),
        // A partial download is progress worth keeping: leave the selection (and its precision)
        // alone so the wizard's model step offers "Resume" over the bytes already on disk instead
        // of restarting from a different model.
        reset_to_default: state != SelectedState::Partial,
    }
}

/// Flatten a raw cache probe into the locally-complete candidates the picker policy accepts.
///
/// Two filters, both load-bearing:
///   * only `cached` precisions — a `partial` one cannot load (the resolver fails fast on a missing
///     weight file rather than silently refetching gigabytes);
///   * only models whose family has a WIRED Rust engine, since a cached-but-unwired export would
///     switch cleanly and then fail every decode with "no Rust engine yet".
fn candidates_from(probe: &BTreeMap<String, ModelQuantCache>) -> Vec<CachedSelection> {
    let mut out = Vec::new();
    for (model_id, quants) in probe {
        let Some(entry) = catalog::find(model_id) else {
            continue;
        };
        if !is_decodable(entry) {
            continue;
        }
        for (quantization, (state, downloaded, total)) in &quants.by_quant {
            if *state != CacheState::Cached {
                continue;
            }
            out.push(CachedSelection {
                model_id: model_id.clone(),
                quantization: quantization.clone(),
                bytes: (*total).max(*downloaded),
            });
        }
    }
    out
}

/// Read one model's probe rows back as a [`SelectedState`].
fn state_of(probe: &BTreeMap<String, ModelQuantCache>, model_id: &str) -> SelectedState {
    let Some(quants) = probe.get(model_id) else {
        return SelectedState::Missing;
    };
    let mut partial = false;
    for (state, _, _) in quants.by_quant.values() {
        match state {
            CacheState::Cached => return SelectedState::Usable,
            CacheState::Partial => partial = true,
            CacheState::NotCached => {}
        }
    }
    if partial {
        SelectedState::Partial
    } else {
        SelectedState::Missing
    }
}

/// True iff this catalog row's family has a decode engine wired in Rust today.
fn is_decodable(entry: &ModelEntry) -> bool {
    super::backend::engine_kind_for(entry).is_some()
}

fn probe_model_of(entry: &ModelEntry) -> ProbeModel {
    ProbeModel {
        id: entry.id.to_string(),
        family: entry.family.as_str().to_string(),
        onnx_name: entry.onnx_model_name.to_string(),
        quantizations: entry
            .available_quantizations
            .iter()
            .map(|q| (*q).to_string())
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// The startup pass
// ---------------------------------------------------------------------------

/// Drive one of the cache probes from a sync caller. Mirrors the runtime-context branch documented
/// in `backend::cloud_transcribe`: valid from a tokio worker AND from a plain `std::thread` (which
/// is what the deferred startup path is).
fn block_on_probe<F: std::future::Future>(future: F) -> F::Output {
    if tokio::runtime::Handle::try_current().is_ok() {
        tokio::task::block_in_place(|| tauri::async_runtime::block_on(future))
    } else {
        tauri::async_runtime::block_on(future)
    }
}

/// Reconcile the persisted STT selection with what is on disk, WITHOUT persisting anything.
/// Split from [`recover_stt_selection_at_startup`] so the probe/decision half stays free of the
/// settings-write + onboarding-gate side effects.
fn evaluate(app: &AppHandle) -> SttSelectionRecovery {
    let settings = crate::winstt::settings_store::read_settings_raw(app);
    let selected = settings.model.model.trim().to_string();

    // A cloud `provider:model` selection holds no local weights; its own connectivity failure path
    // (`stt::fallback`) already salvages an utterance onto a local model when one exists.
    if crate::winstt::cloud_stt::provider_of(&selected).is_some() {
        return SttSelectionRecovery::Intact;
    }

    // STAGE 1 — the cheap question: is the SELECTED model loadable from disk? Probing just this one
    // model scopes the (bounded) external-data verify to its repo alone.
    let state = match catalog::find(&selected).filter(|entry| is_decodable(entry)) {
        Some(entry) => {
            let probe = block_on_probe(cache_probe::probe_cache(&[probe_model_of(entry)]));
            if probe.is_empty() {
                // NOT "nothing is cached": `probe_cache` returns a row for EVERY model it was
                // asked about, so an empty map means the probe itself failed (no HF client, cache
                // scan IO error). Changing the selection — or forcing setup — off an unreadable
                // cache would be worse than leaving the user where they were.
                log::warn!("[startup] STT cache probe unavailable; leaving '{selected}' selected");
                return SttSelectionRecovery::Intact;
            }
            state_of(&probe, entry.id)
        }
        // Not in the catalog (a stale id from an older build, or a hand-edited settings file) or a
        // family with no Rust engine — either way there is nothing here that can decode.
        None => SelectedState::Missing,
    };
    if state == SelectedState::Usable {
        return SttSelectionRecovery::Intact;
    }

    // STAGE 2 — only now (the already-broken path) pay for the whole-catalog walk that tells us
    // what the user DOES have.
    let all: Vec<ProbeModel> = catalog::STT_CATALOG.iter().map(probe_model_of).collect();
    let probe = block_on_probe(cache_probe::probe_cache(&all));
    if probe.is_empty() {
        log::warn!("[startup] STT cache probe unavailable; leaving '{selected}' selected");
        return SttSelectionRecovery::Intact;
    }
    decide_recovery(&selected, state, candidates_from(&probe))
}

/// Persist the recovered selection and, when nothing is installed at all, re-arm the first-run
/// wizard. Returns the outcome (for logging / tests).
///
/// Call this ONCE from the startup path, BEFORE the STT boot/warmup is scheduled and before the
/// window-visibility decision reads `should_show_onboarding` — both consume what this sets.
pub fn recover_stt_selection_at_startup(app: &AppHandle) -> SttSelectionRecovery {
    let outcome = evaluate(app);
    match &outcome {
        SttSelectionRecovery::Intact => {}
        SttSelectionRecovery::Switched { from, to } => {
            log::warn!(
                "[startup] selected STT model '{from}' is not installed on this machine; \
                 switching to '{}' ({}) which is",
                to.model_id,
                quant_label(&to.quantization),
            );
            persist_selection(app, &to.model_id, &to.quantization);
            crate::winstt::observability::IssueBuilder::new(
                "stt",
                "model_selection_recovered",
                "Selected speech model was not installed; switched to an installed one",
            )
            .detail(format!(
                "'{from}' has no complete download in the model cache; WinSTT switched to \
                 '{}' ({}).",
                to.model_id,
                quant_label(&to.quantization),
            ))
            .model_id(to.model_id.clone())
            .severity("warn")
            .record_without_log(Some(app));
        }
        SttSelectionRecovery::SetupRequired {
            from,
            reset_to_default,
        } => {
            log::warn!(
                "[startup] no speech model is installed (selected '{from}'); re-running first-run \
                 setup{}",
                if *reset_to_default {
                    ", selection reset to the factory default"
                } else {
                    ", keeping the partially-downloaded selection so setup can resume it"
                },
            );
            if *reset_to_default {
                // Mirrors the model-uninstall reset: the factory default with "auto" precision, so
                // the wizard offers the small starter download instead of the multi-GB model the
                // user can no longer load. They can pick a bigger one in Settings afterwards.
                persist_selection(app, DEFAULT_STT_MODEL_ID, "auto");
            }
            // Hold the app model-free and route startup into the wizard instead of the main window.
            crate::winstt::commands::onboarding::set_model_setup_required(true);
            crate::winstt::commands::onboarding::set_onboarding_active(true);
            crate::winstt::observability::IssueBuilder::new(
                "stt",
                "model_setup_required",
                "No speech model is installed; setup restarted",
            )
            .detail(format!(
                "'{from}' has no complete download in the model cache and no other installed \
                 model was found, so WinSTT reopened first-run setup to download one."
            ))
            .severity("warn")
            .record_without_log(Some(app));
        }
    }
    outcome
}

fn quant_label(quantization: &str) -> &str {
    if quantization.is_empty() {
        "default precision"
    } else {
        quantization
    }
}

/// Persist `model.model` + `model.onnxQuantization` and broadcast the new snapshot.
///
/// Written DIRECTLY (read → mutate → seal → write under the process-wide settings write lock,
/// exactly like `onboarding::mark_onboarded`) rather than through `apply_settings_patch`: that
/// entry point fans out to every runtime side-effect (STT/TTS/LLM/encoder/wakeword/audio/autostart/
/// tray), and this runs at the very start of the boot sequence, before those managers, the tray,
/// and the windows exist. None of that fan-out is wanted here anyway — the STT boot/warmup that
/// follows reads the settings fresh, and the setup-required path deliberately stays model-free.
fn persist_selection(app: &AppHandle, model_id: &str, quantization: &str) {
    let write = crate::winstt::settings_store::with_settings_write_lock(|| {
        let mut settings = crate::winstt::settings_store::try_read_settings(app)?;
        if settings.model.model == model_id && settings.model.onnx_quantization == quantization {
            return Ok(None);
        }
        settings.model.model = model_id.to_string();
        // Pin the precision that is ACTUALLY on disk (or "auto" for the default reset). Carrying
        // the old model's precision forward would re-resolve to something this model may not have
        // cached — the same stranding, one model over.
        settings.model.onnx_quantization = quantization.to_string();

        let mut to_persist = settings.clone();
        crate::winstt::settings_store::try_seal_secrets(&mut to_persist)?;
        crate::winstt::settings_store::write_settings_value(app, &to_persist)?;
        Ok::<_, String>(Some(settings))
    });

    match write {
        Ok(Some(mut settings)) => {
            crate::winstt::settings_store::sanitize_settings_for_renderer(&mut settings);
            if let Ok(snapshot) = serde_json::to_value(&settings) {
                use tauri::Emitter;
                let _ = app.emit(
                    crate::winstt::commands::settings::SETTINGS_CHANGED_EVENT,
                    serde_json::json!({ "settings": snapshot }),
                );
            }
        }
        Ok(None) => {}
        Err(err) => {
            log::error!("[startup] failed to persist recovered STT selection '{model_id}': {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selection(model_id: &str, quantization: &str, bytes: u64) -> CachedSelection {
        CachedSelection {
            model_id: model_id.to_string(),
            quantization: quantization.to_string(),
            bytes,
        }
    }

    fn probe(rows: &[(&str, &[(&str, CacheState)])]) -> BTreeMap<String, ModelQuantCache> {
        rows.iter()
            .map(|(id, quants)| {
                let mut cache = ModelQuantCache::default();
                for (quant, state) in *quants {
                    cache
                        .by_quant
                        .insert((*quant).to_string(), (*state, 100, 100));
                }
                ((*id).to_string(), cache)
            })
            .collect()
    }

    #[test]
    fn cached_factory_default_wins_over_every_smaller_model() {
        // The default is the deterministic target of EVERY automatic fallback — a cached `tiny`
        // must win even when a smaller cached model exists (this is what stops a recovery from
        // silently landing on, say, a Russian-only Vosk export).
        let pick = pick_cached_selection([
            selection("moonshine-tiny", "int8", 10),
            selection("tiny", "", 500),
            selection("base", "", 20),
        ]);
        assert_eq!(pick, Some(selection("tiny", "", 500)));
    }

    #[test]
    fn without_the_default_the_smallest_cached_precision_wins() {
        let pick = pick_cached_selection([
            selection("small", "", 900),
            selection("base", "q4", 30),
            selection("base", "", 200),
        ]);
        assert_eq!(pick, Some(selection("base", "q4", 30)));
    }

    #[test]
    fn no_candidates_yields_no_pick() {
        assert_eq!(pick_cached_selection([]), None);
    }

    #[test]
    fn a_usable_selection_is_left_alone() {
        assert_eq!(
            decide_recovery("base", SelectedState::Usable, [selection("tiny", "", 1)]),
            SttSelectionRecovery::Intact
        );
    }

    #[test]
    fn a_missing_selection_switches_to_an_installed_model() {
        assert_eq!(
            decide_recovery(
                "nemo-parakeet-tdt-0.6b-v3",
                SelectedState::Missing,
                [selection("base", "int8", 40)],
            ),
            SttSelectionRecovery::Switched {
                from: "nemo-parakeet-tdt-0.6b-v3".to_string(),
                to: selection("base", "int8", 40),
            }
        );
    }

    #[test]
    fn nothing_installed_forces_setup_and_resets_to_the_default() {
        // The reported bug: settings carried over to a machine with an EMPTY model cache.
        assert_eq!(
            decide_recovery("nemo-parakeet-tdt-0.6b-v3", SelectedState::Missing, []),
            SttSelectionRecovery::SetupRequired {
                from: "nemo-parakeet-tdt-0.6b-v3".to_string(),
                reset_to_default: true,
            }
        );
    }

    #[test]
    fn a_partial_selection_is_kept_so_setup_can_resume_it() {
        // Interrupted multi-GB download: restarting from the factory default would throw those
        // bytes away, so the wizard keeps the selection and offers "Resume".
        assert_eq!(
            decide_recovery("nemo-canary-1b-v2", SelectedState::Partial, []),
            SttSelectionRecovery::SetupRequired {
                from: "nemo-canary-1b-v2".to_string(),
                reset_to_default: false,
            }
        );
    }

    #[test]
    fn candidates_take_only_complete_precisions_of_decodable_models() {
        let probed = probe(&[
            (
                "tiny",
                &[("", CacheState::Cached), ("fp16", CacheState::Partial)],
            ),
            ("base", &[("", CacheState::NotCached)]),
            // Not a catalog id at all — must never become a fallback target.
            ("ghost-model", &[("", CacheState::Cached)]),
        ]);
        let candidates = candidates_from(&probed);
        assert_eq!(candidates, vec![selection("tiny", "", 100)]);
    }

    #[test]
    fn selected_state_reads_cached_over_partial() {
        let probed = probe(&[(
            "tiny",
            &[("", CacheState::Partial), ("fp16", CacheState::Cached)],
        )]);
        assert_eq!(state_of(&probed, "tiny"), SelectedState::Usable);

        let partial = probe(&[("tiny", &[("", CacheState::Partial)])]);
        assert_eq!(state_of(&partial, "tiny"), SelectedState::Partial);

        let cold = probe(&[("tiny", &[("", CacheState::NotCached)])]);
        assert_eq!(state_of(&cold, "tiny"), SelectedState::Missing);
        assert_eq!(state_of(&cold, "base"), SelectedState::Missing);
    }
}

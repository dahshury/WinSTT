// Source: app/src-tauri/src/managers/audio.rs (the COM session enumeration
// pattern, plus reduction math + duck/restore ledger).
//
// Graduated system-audio ducking while dictating (and during Read Aloud). The
// goal — verbatim from the request that drove this design — is:
//
//   "All audio should be ducked to the specified setting FIRST, before playing
//    the recording sound. The recording sound itself should stay high and must
//    NOT be ducked."
//
// That requirement rules out master-endpoint-volume ducking
// (`IAudioEndpointVolume::SetMasterVolumeLevelScalar`), because the master
// scalar attenuates EVERYTHING on the endpoint — including WinSTT's own
// recording chime, which plays in-process through rodio. So we duck PER SESSION
// (`ISimpleAudioVolume` on every audio session of the default render endpoint)
// and PROTECT WinSTT's own process tree; background apps drop to the configured
// level, the chime stays loud, and we can duck first / chime second.
//
// ROBUSTNESS MODEL — Windows REMEMBERS per-app session volumes across app and
// OS restarts, so any duck we fail to undo permanently corrupts the user's
// mixer. Every failure mode therefore has an explicit answer:
//
//   1. Total ordering. ONE worker thread owns BOTH the ledger (which features
//      want the duck, what we captured) and every COM side effect. Callers only
//      send messages. There is no window where a new duck can observe (and
//      snapshot) volumes a previous cycle's restore has not finished writing —
//      the ratchet-to-mute race that plagued the lock-then-enqueue design.
//   2. Gate on the worker. A dictation duck re-checks "is this recording still
//      live?" ON the worker, immediately before the COM duck. A stop that lands
//      while the duck request is in flight either (a) flips the gate before the
//      duck runs → the duck is skipped, or (b) lands after → its Restore message
//      is queued behind the duck and undoes it. No stranded duck either way.
//   3. Only undo what we did. Each snapshot records BOTH the pre-duck volume and
//      the exact value we wrote. A restore only rewrites sessions still sitting
//      at (about) the value we set — a slider the user moved mid-duck is left
//      alone, and a stale/duplicate restore can never stomp anything.
//   4. Watchdog. While ducked, the worker periodically re-checks each reason's
//      liveness (recording generation / TTS island). If the terminal event that
//      should have restored us was lost (pipeline panic, dropped event), the
//      duck is force-released within ~15s instead of holding forever.
//   5. VERIFIED restore — never assume, never silently drop. A restore is
//      accounted per session: found (by instance id, then pid, then executable
//      name), guarded (rule 3), written, and READ BACK. Any snapshot that is
//      missing from the enumeration or whose write cannot be verified moves to
//      a pending pool that is retried by the watchdog, healed right before the
//      next duck, restored on exit, and journaled to disk — it is never
//      forgotten just because one enumeration didn't see the session. (The old
//      code treated "enumeration succeeded" as "everything restored", which
//      permanently muted any session that had expired, changed pid, or failed
//      its write — invisibly, since Windows persists per-app volumes and a
//      100% duck leaves the session at exactly 0.)
//   6. Crash persistence. Live + pending snapshots are journaled to disk while
//      anything is outstanding and the journal is deleted only when every
//      session is verifiably back. The next launch feeds any leftovers into the
//      same pending pool (guarded by rule 3) instead of one-shot restoring and
//      unconditionally deleting the journal.
//   7. Exit hook. `restore_all_blocking_on_exit` runs from Tauri's
//      ExitRequested cleanup so a graceful quit mid-dictation restores
//      synchronously (bounded wait), including a final heal attempt for the
//      pending pool.
//   8. COM lifetime. The worker thread initializes its COM apartment ONCE for
//      its whole lifetime. (Per-enumeration init/uninit tore the apartment down
//      while returned `ISimpleAudioVolume` pointers were still live — calls
//      through them afterwards are undefined and can fail silently.)
//
// The reduction/clamp/ledger logic is pure and fully tested (COM is abstracted
// behind `DuckOps`); the only unverifiable bit is runtime COM behavior.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::time::{Duration, Instant};

// ───────────────────────── pure reduction math ────────────────────────

/// Clamp a scalar to [0, 1]. NaN → 0. Mirrors clampScalar.
pub fn clamp_scalar(value: f32) -> f32 {
    if value.is_nan() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

/// The ducked volume for a given previous volume and percent reduction.
/// pct=100 → 0.0 (full mute); pct=80 → 20% of previous; pct=0 → unchanged.
/// Clamped to [0, 1]. Mirrors reductionTarget.
pub fn reduction_target(volume: f32, pct: u8) -> f32 {
    let pct = pct.min(100) as f32;
    clamp_scalar((volume * (100.0 - pct)) / 100.0)
}

/// Parse a scalar string (volume readout), tolerant of `,` decimal separators
/// and surrounding whitespace. None on unparseable. Mirrors parseVolume.
pub fn parse_volume(value: &str) -> Option<f32> {
    let normalized = value.replace(',', ".");
    let n: f32 = normalized.trim().parse().ok()?;
    if n.is_nan() {
        return None;
    }
    Some(clamp_scalar(n))
}

// ───────────────────────────── snapshots ───────────────────────────────

/// One session's pre-duck volume. Keyed by the WASAPI session instance
/// identifier (stable for the session's lifetime, unlike the COM object across
/// enumerations, and unlike a bare pid for processes with several sessions),
/// with the pid and the process's executable name kept as fallback matchers for
/// sessions the process re-created mid-duck (same pid, new instance id) or that
/// came back under a whole new process (browser audio-service churn, app
/// restarts — Windows hands the re-created session the ducked volume it
/// remembered for that app).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct SessionVolumeSnapshot {
    /// Session instance identifier, or `"pid:<n>"` when unavailable.
    key: String,
    pid: u32,
    /// Lower-cased executable file name of `pid` at duck time ("chrome.exe").
    /// Optional so journals written by older builds still deserialize.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exe: Option<String>,
    /// The user's volume before we ducked.
    previous: f32,
    /// The exact value we wrote. A restore only rewrites `previous` while the
    /// session still sits at (about) this value — "only undo what we did".
    ducked_to: f32,
}

/// How far a session's current volume may drift from the value we wrote and
/// still count as "ours" (float round-trips through WASAPI are not exact).
/// Windows-only: session-volume restore is a WASAPI concept with no
/// non-Windows counterpart (the `#[cfg(not(windows))]` ducking path differs).
#[cfg(windows)]
const RESTORE_TOLERANCE: f32 = 0.02;

/// A restore may only rewrite a session that still sits at the value we set.
#[cfg(windows)]
fn volume_still_ours(current: f32, ducked_to: f32) -> bool {
    (current - ducked_to).abs() <= RESTORE_TOLERANCE
}

// ───────────────────── worker-owned duck ledger ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuckReason {
    Dictation,
    ReadAloud,
}

/// Authoritative "does this feature still want the duck?" probe, evaluated on
/// the worker (dictation: recording generation still live; Read Aloud: TTS
/// island still shown). Used both to gate a duck whose stop already landed and
/// to reap a duck whose restore event was lost.
type Liveness = Arc<dyn Fn() -> bool + Send + Sync>;

struct ActiveReason {
    reason: DuckReason,
    liveness: Option<Liveness>,
    since: Instant,
}

#[derive(Default)]
struct WorkerState {
    /// Features currently holding the duck (first one captured the snapshots;
    /// later ones piggyback; last one out restores).
    active: Vec<ActiveReason>,
    /// We actually lowered sessions and hold their snapshots.
    ducked: bool,
    snapshots: Vec<SessionVolumeSnapshot>,
    /// Sessions whose restore could not be VERIFIED — missing from the
    /// enumeration (expired session, device switch, process gone), failed
    /// write, or failed read-back — plus any leftovers a previous run
    /// journaled. Retried by the watchdog, healed right before the next duck
    /// and on exit, and kept in the on-disk journal until each one is
    /// verifiably back. Robustness rule 5.
    pending_restore: Vec<SessionVolumeSnapshot>,
    /// Last time the pending pool was attempted (rate-limits watchdog retries).
    pending_last_attempt: Option<Instant>,
}

/// The side-effect surface of the ledger, so the transition logic is testable
/// without COM or a filesystem.
trait DuckOps {
    /// Capture + lower background sessions. `None` = enumeration failed.
    fn duck(&mut self, reduction_pct: u8) -> Option<Vec<SessionVolumeSnapshot>>;
    /// Put sessions back, VERIFYING each write. Returns the keys that are now
    /// settled: restored with a matching read-back, or deliberately left alone
    /// because the slider moved while we were ducked (rule 3). A key that is
    /// NOT returned stays unresolved and must be retried later. `None` = the
    /// session enumeration itself failed (nothing was attempted).
    fn restore(&mut self, snapshots: &[SessionVolumeSnapshot]) -> Option<Vec<String>>;
    /// Journal the snapshots for crash recovery.
    fn persist(&mut self, snapshots: &[SessionVolumeSnapshot]);
    /// Delete the crash-recovery journal.
    fn clear_persisted(&mut self);
}

/// How often the worker wakes to run the watchdog while idle-waiting for jobs.
const WATCHDOG_TICK: Duration = Duration::from_secs(5);
/// How long a reason may hold the duck before the watchdog starts checking its
/// liveness (covers e.g. the Read Aloud island being shown a beat AFTER its
/// duck request).
const REAP_GRACE: Duration = Duration::from_secs(10);
/// Minimum spacing between watchdog retries of the pending-restore pool. The
/// pool is also retried opportunistically (before every duck, on exit), so the
/// watchdog cadence only bounds how long a quiet system stays unhealed.
const PENDING_RETRY_INTERVAL: Duration = Duration::from_secs(30);

/// Mirror the ledger to the crash journal: live + pending snapshots while
/// anything is outstanding, no file at all once everything is verifiably back.
fn persist_ledger(state: &WorkerState, ops: &mut impl DuckOps) {
    if state.snapshots.is_empty() && state.pending_restore.is_empty() {
        ops.clear_persisted();
    } else {
        let union: Vec<SessionVolumeSnapshot> = state
            .snapshots
            .iter()
            .chain(&state.pending_restore)
            .cloned()
            .collect();
        ops.persist(&union);
    }
}

/// Queue an unresolved snapshot for later healing. When the key is already
/// pending, the OLDER entry wins — its `previous` predates our interference.
fn push_pending(state: &mut WorkerState, snapshot: SessionVolumeSnapshot) {
    if state
        .pending_restore
        .iter()
        .any(|pending| pending.key == snapshot.key)
    {
        return;
    }
    state.pending_restore.push(snapshot);
}

/// Retry the pending pool once (verified, like every restore). Called from the
/// watchdog (rate-limited by the caller), right before a fresh duck — so a
/// session an earlier cycle failed to un-duck is put back BEFORE we snapshot
/// it again, which both heals the stuck volume and preserves the anti-ratchet
/// invariant — and from the exit hook.
fn heal_pending(state: &mut WorkerState, ops: &mut impl DuckOps) {
    if state.pending_restore.is_empty() {
        return;
    }
    state.pending_last_attempt = Some(Instant::now());
    let Some(resolved) = ops.restore(&state.pending_restore) else {
        return;
    };
    if resolved.is_empty() {
        return;
    }
    let resolved: HashSet<String> = resolved.into_iter().collect();
    let before = state.pending_restore.len();
    state
        .pending_restore
        .retain(|snapshot| !resolved.contains(&snapshot.key));
    if state.pending_restore.len() < before {
        log::info!(
            "[ducking] healed {} previously unrestorable session volume(s) ({} still pending)",
            before - state.pending_restore.len(),
            state.pending_restore.len()
        );
        persist_ledger(state, ops);
    }
}

fn handle_duck(
    state: &mut WorkerState,
    ops: &mut impl DuckOps,
    reason: DuckReason,
    reduction_pct: u8,
    liveness: Option<Liveness>,
    gate_before_duck: bool,
) {
    // Robustness rule 2: the authoritative "still wanted?" check runs HERE, on
    // the worker, after every previously queued restore has fully applied. A
    // recording whose stop already landed (fast PTT tap) is not ducked at all.
    if gate_before_duck && liveness.as_ref().is_some_and(|alive| !alive()) {
        log::debug!("[ducking] duck for {reason:?} skipped -- no longer wanted");
        return;
    }
    if let Some(existing) = state.active.iter_mut().find(|a| a.reason == reason) {
        // Duplicate request while the reason is still held (its restore was
        // lost or is still queued behind us): refresh the liveness probe and
        // the grace clock so the watchdog tracks THIS cycle — a stale closure
        // from the previous cycle would report "dead" and reap the duck out
        // from under the live recording.
        if liveness.is_some() {
            existing.liveness = liveness;
        }
        existing.since = Instant::now();
        return;
    }
    state.active.push(ActiveReason {
        reason,
        liveness,
        since: Instant::now(),
    });
    if state.ducked {
        // Piggyback on the existing duck: the sessions are already lowered and
        // the original pre-duck snapshots stay authoritative (anti-ratchet).
        return;
    }
    // Heal FIRST: a session an earlier cycle could not restore may be back in
    // the enumeration now. Restoring it before the duck both un-sticks its
    // volume and lets the duck below capture a TRUE pre-duck snapshot instead
    // of re-snapshotting a ducked level (rule 5).
    heal_pending(state, ops);
    match ops.duck(reduction_pct) {
        Some(snapshots) => {
            log::debug!(
                "[ducking] ducked {} session(s) at {reduction_pct}% reduction",
                snapshots.len()
            );
            state.ducked = true;
            state.snapshots = snapshots;
            persist_ledger(state, ops);
        }
        None => {
            log::warn!("[ducking] session enumeration failed; nothing ducked");
        }
    }
}

fn handle_restore(state: &mut WorkerState, ops: &mut impl DuckOps, reason: DuckReason) {
    state.active.retain(|a| a.reason != reason);
    try_restore_if_idle(state, ops);
}

fn try_restore_if_idle(state: &mut WorkerState, ops: &mut impl DuckOps) {
    if !state.active.is_empty() || !state.ducked {
        return;
    }
    if state.snapshots.is_empty() {
        state.ducked = false;
        persist_ledger(state, ops);
        return;
    }
    let Some(resolved) = ops.restore(&state.snapshots) else {
        // The enumeration itself failed (audio-service hiccup). Keep the duck
        // marked live so the watchdog retries the whole restore; nothing has
        // been attempted, so nothing may be dropped. Robustness rule 5.
        log::warn!("[ducking] restore enumeration failed; keeping snapshots and retrying");
        return;
    };
    let resolved: HashSet<String> = resolved.into_iter().collect();
    let snapshots = std::mem::take(&mut state.snapshots);
    let total = snapshots.len();
    let mut unresolved = 0usize;
    for snapshot in snapshots {
        if !resolved.contains(&snapshot.key) {
            unresolved += 1;
            push_pending(state, snapshot);
        }
    }
    state.ducked = false;
    if unresolved > 0 {
        // Their sessions were missing or their writes did not verify; keep
        // them pending (journaled) and retry rather than assuming success.
        state.pending_last_attempt = Some(Instant::now());
        log::warn!(
            "[ducking] {unresolved}/{total} ducked session(s) not verifiably restored; keeping them journaled for retry"
        );
    }
    persist_ledger(state, ops);
}

fn watchdog_tick(state: &mut WorkerState, ops: &mut impl DuckOps) {
    // Robustness rule 4: a reason whose terminal event was lost (pipeline
    // panic, dropped emit) must not hold the user's mixer down forever. Past
    // the grace period, a reason whose liveness probe says "no longer wanted"
    // is force-released. Reasons without a probe are only released by their
    // explicit restore or the exit hook.
    if !state.active.is_empty() {
        let before = state.active.len();
        state.active.retain(|a| {
            a.since.elapsed() < REAP_GRACE || a.liveness.as_ref().is_none_or(|alive| alive())
        });
        if state.active.len() < before {
            log::warn!(
                "[ducking] watchdog released {} stale duck reason(s) whose restore never arrived",
                before - state.active.len()
            );
        }
    }
    // Covers a reason reaped above, a restore whose enumeration failed, AND a
    // restore job that panicked mid-way (ducked with no owner left).
    if state.active.is_empty() && state.ducked {
        try_restore_if_idle(state, ops);
    }
    if !state.pending_restore.is_empty()
        && state
            .pending_last_attempt
            .is_none_or(|at| at.elapsed() >= PENDING_RETRY_INTERVAL)
    {
        heal_pending(state, ops);
    }
}

/// Exit hook body: release every reason, restore the live duck, and give the
/// pending pool one final heal so a graceful quit leaves nothing muted.
fn handle_restore_all(state: &mut WorkerState, ops: &mut impl DuckOps) {
    state.active.clear();
    try_restore_if_idle(state, ops);
    heal_pending(state, ops);
}

/// Startup recovery: feed a previous run's journaled snapshots into the same
/// verified-healing machinery live cycles use. Never one-shot-and-forget, and
/// never clobber the journal of a duck that is already live in THIS run.
fn handle_restore_orphaned(
    state: &mut WorkerState,
    ops: &mut impl DuckOps,
    snapshots: Vec<SessionVolumeSnapshot>,
) {
    let count = snapshots.len();
    for snapshot in snapshots {
        push_pending(state, snapshot);
    }
    log::info!("[ducking] queued {count} session volume(s) left ducked by a previous run");
    heal_pending(state, ops);
    persist_ledger(state, ops);
}

// ─────────────────────── serialized COM executor ───────────────────────────
//
// Every ledger transition AND every COM duck/restore runs on ONE worker thread,
// in message order (robustness rule 1). `perform_session_duck` snapshots each
// session's live volume before lowering it, so it must never observe a session
// that a previous cycle's restore has not finished putting back — and it can't:
// restore N is a message that fully applies before duck N+1 is even decided.

enum ComJob {
    Duck {
        reason: DuckReason,
        reduction_pct: u8,
        liveness: Option<Liveness>,
        /// Check `liveness` right before the COM duck and skip when stale
        /// (dictation). Read Aloud requests its duck a beat before the island
        /// shows, so it must not gate.
        gate_before_duck: bool,
        ack: Option<mpsc::SyncSender<()>>,
    },
    Restore {
        reason: DuckReason,
    },
    /// Exit hook: release every reason and restore synchronously.
    RestoreAll {
        ack: Option<mpsc::SyncSender<()>>,
    },
    /// Startup: feed sessions a previous (crashed) run left ducked, from the
    /// on-disk journal, into the pending-restore pool.
    RestoreOrphaned {
        snapshots: Vec<SessionVolumeSnapshot>,
    },
}

static COM_JOBS: OnceLock<Mutex<mpsc::Sender<ComJob>>> = OnceLock::new();

/// Lazily start the single ducking worker thread and hand back its job sender.
fn com_jobs() -> mpsc::Sender<ComJob> {
    let sender = COM_JOBS.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<ComJob>();
        std::thread::Builder::new()
            .name("winstt-ducking".into())
            .spawn(move || worker_loop(&rx))
            .expect("spawn winstt-ducking worker");
        Mutex::new(tx)
    });
    match sender.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

fn enqueue_com_job(job: ComJob) {
    let _ = com_jobs().send(job);
}

fn worker_loop(rx: &mpsc::Receiver<ComJob>) {
    // Robustness rule 8: the apartment must outlive every WASAPI interface the
    // jobs enumerate, so it is initialized once for the worker's lifetime. The
    // worker never exits before process teardown, so it is never uninitialized
    // while a job is in flight.
    #[cfg(windows)]
    let _com = crate::windows_com::ComApartment::init_multithreaded();
    let mut state = WorkerState::default();
    let mut ops = RealOps;
    loop {
        match rx.recv_timeout(WATCHDOG_TICK) {
            Ok(job) => handle_job(&mut state, &mut ops, job),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Same panic containment as handle_job: the watchdog runs COM
                // restores too, and a panic here would kill the worker (and
                // with it every future restore) silently.
                let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    watchdog_tick(&mut state, &mut ops);
                }));
                if caught.is_err() {
                    log::error!("[ducking] the ducking watchdog panicked; worker continues");
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn handle_job(state: &mut WorkerState, ops: &mut RealOps, job: ComJob) {
    // A panic in any single job (COM oddity, sysinfo scan) must not kill the
    // worker — every queued restore after it still has to run.
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match job {
        ComJob::Duck {
            reason,
            reduction_pct,
            liveness,
            gate_before_duck,
            ack,
        } => {
            handle_duck(
                state,
                ops,
                reason,
                reduction_pct,
                liveness,
                gate_before_duck,
            );
            if let Some(ack) = ack {
                let _ = ack.send(());
            }
        }
        ComJob::Restore { reason } => handle_restore(state, ops, reason),
        ComJob::RestoreAll { ack } => {
            handle_restore_all(state, ops);
            if let Some(ack) = ack {
                let _ = ack.send(());
            }
        }
        ComJob::RestoreOrphaned { snapshots } => handle_restore_orphaned(state, ops, snapshots),
    }));
    if caught.is_err() {
        log::error!("[ducking] a ducking job panicked; worker continues");
    }
}

// ───────────────────────── public duck/restore API ─────────────────────────

fn settings_duck_reduction_pct(app: &tauri::AppHandle) -> u8 {
    crate::winstt::settings_store::read_settings_raw(app)
        .general
        .system_audio_reduction_while_dictating
        .clamp(0, 100) as u8
}

/// Apply `general.systemAudioReductionWhileDictating`, BLOCKING (bounded) until
/// the background sessions are actually lowered. The recording-chime path calls
/// this FIRST so background audio is ducked before the chime plays — the chime
/// is in WinSTT's own (protected) process, so it stays at full volume.
///
/// `still_active` must report whether THIS recording is still capturing; it is
/// re-checked on the ducking worker immediately before the COM duck (so a stop
/// that raced the request skips the duck) and again by the watchdog while the
/// duck is held (so a lost terminal event cannot strand it).
pub fn duck_from_settings_blocking(
    app: &tauri::AppHandle,
    still_active: impl Fn() -> bool + Send + Sync + 'static,
) {
    let pct = settings_duck_reduction_pct(app);
    if pct == 0 {
        return;
    }
    let (ack_tx, ack_rx) = mpsc::sync_channel::<()>(1);
    enqueue_com_job(ComJob::Duck {
        reason: DuckReason::Dictation,
        reduction_pct: pct,
        liveness: Some(Arc::new(still_active)),
        gate_before_duck: true,
        ack: Some(ack_tx),
    });
    // Bounded: a hung audio service must not wedge the chime thread forever.
    let _ = ack_rx.recv_timeout(Duration::from_secs(3));
}

/// Apply `general.systemAudioReductionWhileDictating` for Read Aloud playback.
/// Liveness follows the TTS island: if the playback-ended report is ever lost,
/// the watchdog releases the duck once the island is gone.
pub fn duck_read_aloud_from_settings(app: &tauri::AppHandle) {
    let pct = settings_duck_reduction_pct(app);
    if pct == 0 {
        return;
    }
    enqueue_com_job(ComJob::Duck {
        reason: DuckReason::ReadAloud,
        reduction_pct: pct,
        liveness: Some(Arc::new(
            crate::winstt::commands::overlay::tts_overlay_is_active,
        )),
        // The duck is requested a beat BEFORE show_tts_overlay flips the flag.
        gate_before_duck: false,
        ack: None,
    });
}

/// Restore the background sessions ducked for dictation (PTT release / terminal
/// event). No-op unless dictation was the last reason holding the duck.
pub fn request_restore() {
    enqueue_com_job(ComJob::Restore {
        reason: DuckReason::Dictation,
    });
}

/// Restore the background sessions ducked for Read Aloud (playback ended /
/// cancelled). No-op unless Read Aloud was the last reason holding the duck.
pub fn request_read_aloud_restore() {
    enqueue_com_job(ComJob::Restore {
        reason: DuckReason::ReadAloud,
    });
}

/// Exit hook (robustness rule 7): release every duck reason and restore the
/// mixer synchronously, waiting at most 2s so shutdown stays bounded. Windows
/// persists per-app session volumes, so skipping this on a quit-while-ducked
/// would leave the user's apps quiet across reboots.
pub fn restore_all_blocking_on_exit() {
    let (ack_tx, ack_rx) = mpsc::sync_channel::<()>(1);
    enqueue_com_job(ComJob::RestoreAll { ack: Some(ack_tx) });
    if ack_rx.recv_timeout(Duration::from_secs(2)).is_err() {
        log::warn!("[ducking] exit restore did not complete within its deadline");
    }
}

// ─────────────────── crash-recovery journal (rule 6) ───────────────────────

static PERSIST_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

fn persist_path() -> Option<&'static PathBuf> {
    PERSIST_PATH.get().and_then(|p| p.as_ref())
}

/// Wire the crash-recovery journal path and queue any duck a previous run
/// left behind (crash / kill / power loss while dictating) for verified
/// healing. Call once during startup, before the first dictation.
pub fn init(app: &tauri::AppHandle) {
    let path = crate::portable::app_data_dir(app)
        .ok()
        .map(|dir| dir.join("ducked-sessions.json"));
    let _ = PERSIST_PATH.set(path);
    let Some(path) = persist_path() else {
        return;
    };
    if !path.exists() {
        return;
    }
    let snapshots = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<SessionVolumeSnapshot>>(&bytes).ok());
    match snapshots {
        Some(snapshots) if !snapshots.is_empty() => {
            enqueue_com_job(ComJob::RestoreOrphaned { snapshots });
        }
        _ => {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn persist_snapshots_to_disk(snapshots: &[SessionVolumeSnapshot]) {
    let Some(path) = persist_path() else {
        return;
    };
    if snapshots.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_vec(snapshots) {
        Ok(bytes) => {
            if let Err(err) = std::fs::write(path, bytes) {
                log::warn!("[ducking] failed to journal ducked sessions: {err}");
            }
        }
        Err(err) => log::warn!("[ducking] failed to encode ducked-session journal: {err}"),
    }
}

fn clear_persisted_snapshots() {
    if let Some(path) = persist_path() {
        let _ = std::fs::remove_file(path);
    }
}

/// The real side effects: WASAPI session COM plus the on-disk journal.
struct RealOps;

impl DuckOps for RealOps {
    fn duck(&mut self, reduction_pct: u8) -> Option<Vec<SessionVolumeSnapshot>> {
        perform_session_duck(reduction_pct)
    }

    fn restore(&mut self, snapshots: &[SessionVolumeSnapshot]) -> Option<Vec<String>> {
        perform_verified_session_restore(snapshots)
    }

    fn persist(&mut self, snapshots: &[SessionVolumeSnapshot]) {
        persist_snapshots_to_disk(snapshots);
    }

    fn clear_persisted(&mut self) {
        clear_persisted_snapshots();
    }
}

// ── ISimpleAudioVolume per-session COM impl ─────────────────────────────────
//
// Enumerates render-endpoint audio sessions and lowers each one that does NOT
// belong to WinSTT or its child processes. Returns None on any COM failure
// (the caller treats that as "nothing ducked" / "nothing attempted"). All of
// these run on the ducking worker thread, whose COM apartment is held for the
// thread's lifetime (rule 8).

#[cfg(windows)]
struct AudioSessionVolume {
    key: String,
    pid: u32,
    volume: windows::Win32::Media::Audio::ISimpleAudioVolume,
}

/// One process scan serving two needs: the set of process ids to leave alone —
/// WinSTT itself plus every descendant (WebView2 children, etc.), whose
/// in-process rodio chime and overlay-WebView Read Aloud audio must never be
/// ducked — and a pid → lower-cased executable-name map used to stamp each
/// snapshot with its process image (the last-resort restore matcher).
#[cfg(windows)]
fn winstt_process_tree_and_exe_names() -> (
    std::collections::HashSet<u32>,
    std::collections::HashMap<u32, String>,
) {
    use sysinfo::System;

    let current_pid = std::process::id();
    let system = System::new_all();
    let mut protected = std::collections::HashSet::from([current_pid]);

    loop {
        let before = protected.len();
        for (pid, process) in system.processes() {
            if protected.contains(&pid.as_u32()) {
                continue;
            }
            if process
                .parent()
                .is_some_and(|parent| protected.contains(&parent.as_u32()))
            {
                protected.insert(pid.as_u32());
            }
        }
        if protected.len() == before {
            break;
        }
    }

    let exe_names = system
        .processes()
        .iter()
        .map(|(pid, process)| {
            (
                pid.as_u32(),
                process.name().to_string_lossy().to_lowercase(),
            )
        })
        .collect();

    (protected, exe_names)
}

/// The session's instance identifier — stable for the session's lifetime and
/// unique per session even when one process owns several. `"pid:<n>"` fallback.
#[cfg(windows)]
fn session_instance_key(
    control: &windows::Win32::Media::Audio::IAudioSessionControl2,
    pid: u32,
) -> String {
    use windows::Win32::System::Com::CoTaskMemFree;

    // SAFETY: the identifier is a COM-allocated wide string owned by us once
    // returned; it is copied into a Rust String and freed exactly once.
    unsafe {
        if let Ok(pw) = control.GetSessionInstanceIdentifier() {
            let key = pw.to_string().ok();
            CoTaskMemFree(Some(pw.0 as *const _));
            if let Some(key) = key
                && !key.is_empty()
            {
                return key;
            }
        }
    }
    format!("pid:{pid}")
}

/// Append every audio session of one render device to `volumes`. Returns false
/// when the device's session manager could not be activated/enumerated.
#[cfg(windows)]
fn collect_device_session_volumes(
    device: &windows::Win32::Media::Audio::IMMDevice,
    volumes: &mut Vec<AudioSessionVolume>,
) -> bool {
    use windows::Win32::Media::Audio::{
        IAudioSessionControl2, IAudioSessionManager2, ISimpleAudioVolume,
    };
    use windows::Win32::System::Com::CLSCTX_ALL;
    use windows::core::Interface;

    // SAFETY: COM is initialized for the worker thread's lifetime and each
    // interface returned by WASAPI is checked before use.
    unsafe {
        let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
            return false;
        };
        let Ok(sessions) = manager.GetSessionEnumerator() else {
            return false;
        };
        let Ok(count) = sessions.GetCount() else {
            return false;
        };
        for index in 0..count {
            let Ok(session) = sessions.GetSession(index) else {
                continue;
            };
            let Ok(control) = session.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let pid = control.GetProcessId().unwrap_or(0);
            let key = session_instance_key(&control, pid);
            let Ok(volume) = session.cast::<ISimpleAudioVolume>() else {
                continue;
            };
            volumes.push(AudioSessionVolume { key, pid, volume });
        }
        true
    }
}

/// Sessions of the DEFAULT render endpoint — the duck scope (matches what
/// master-volume ducking would have covered).
#[cfg(windows)]
fn enumerate_default_render_session_volumes() -> Option<Vec<AudioSessionVolume>> {
    use windows::Win32::Media::Audio::{
        IMMDeviceEnumerator, MMDeviceEnumerator, eMultimedia, eRender,
    };
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};

    // SAFETY: COM is initialized for the worker thread's lifetime.
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .ok()?;
        let mut volumes = Vec::new();
        if !collect_device_session_volumes(&device, &mut volumes) {
            return None;
        }
        Some(volumes)
    }
}

/// Sessions of EVERY active render endpoint — the restore scope. A default-
/// device switch mid-duck must not orphan the sessions we lowered on the old
/// default, so restores look everywhere.
#[cfg(windows)]
fn enumerate_all_render_session_volumes() -> Option<Vec<AudioSessionVolume>> {
    use windows::Win32::Media::Audio::{
        DEVICE_STATE_ACTIVE, IMMDeviceEnumerator, MMDeviceEnumerator, eRender,
    };
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};

    // SAFETY: COM is initialized for the worker thread's lifetime.
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let collection = enumerator
            .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
            .ok()?;
        let count = collection.GetCount().ok()?;
        let mut volumes = Vec::new();
        // No active device at all (audio service down) still counts as a
        // usable — empty — enumeration only when the collection itself said 0.
        let mut any_device_ok = count == 0;
        for index in 0..count {
            let Ok(device) = collection.Item(index) else {
                continue;
            };
            any_device_ok |= collect_device_session_volumes(&device, &mut volumes);
        }
        if any_device_ok { Some(volumes) } else { None }
    }
}

/// Duck every audio session that does NOT belong to WinSTT's process tree, and
/// return the captured pre-duck volumes so a later restore can put them back.
#[cfg(windows)]
fn perform_session_duck(reduction_pct: u8) -> Option<Vec<SessionVolumeSnapshot>> {
    let (protected, exe_names) = winstt_process_tree_and_exe_names();
    let sessions = enumerate_default_render_session_volumes()?;
    let mut snapshots = Vec::new();

    for session in sessions {
        if protected.contains(&session.pid) {
            continue;
        }
        // SAFETY: `session.volume` is a live WASAPI interface obtained during enumeration.
        let Ok(current) = (unsafe { session.volume.GetMasterVolume() }) else {
            continue;
        };
        let target = reduction_target(current, reduction_pct);
        if (current - target).abs() <= f32::EPSILON {
            // Already at/below the duck level (e.g. a muted app) — nothing to
            // change, so nothing to snapshot or restore either. (A session WE
            // left stuck at the duck level is healed by the pending pool
            // BEFORE this runs, so it does not slip through here.)
            continue;
        }
        // SAFETY: `session.volume` is valid and `target` is clamped to the accepted 0.0..=1.0 range.
        if unsafe {
            session
                .volume
                .SetMasterVolume(target, std::ptr::null())
                .is_ok()
        } {
            snapshots.push(SessionVolumeSnapshot {
                exe: exe_names.get(&session.pid).cloned(),
                key: session.key,
                pid: session.pid,
                previous: current,
                ducked_to: target,
            });
        }
    }

    Some(snapshots)
}

/// Restore with verification, retrying the session enumeration a few times (an
/// audio-service hiccup or device switch mid-restore must not silently drop the
/// snapshots). `None` when every enumeration attempt failed — the ledger keeps
/// everything and retries later.
#[cfg(windows)]
fn perform_verified_session_restore(snapshots: &[SessionVolumeSnapshot]) -> Option<Vec<String>> {
    for attempt in 0..3u32 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(150 * u64::from(attempt)));
        }
        if let Some(sessions) = enumerate_all_render_session_volumes() {
            return Some(apply_verified_session_restore(&sessions, snapshots));
        }
    }
    None
}

/// Put each snapshot back and report the keys that are SETTLED: written and
/// read back at the pre-duck volume, or deliberately left alone because the
/// slider moved while we were ducked (rule 3). Anything else — session missing
/// from the enumeration, failed write, failed read-back — is NOT reported, so
/// the ledger keeps it pending instead of assuming success (rule 5).
#[cfg(windows)]
fn apply_verified_session_restore(
    sessions: &[AudioSessionVolume],
    snapshots: &[SessionVolumeSnapshot],
) -> Vec<String> {
    let mut resolved = Vec::new();
    let mut consumed = vec![false; sessions.len()];
    let mut exe_cache: std::collections::HashMap<u32, Option<String>> =
        std::collections::HashMap::new();

    for snapshot in snapshots {
        let Some(index) = find_session_for_snapshot(sessions, &consumed, snapshot, &mut exe_cache)
        else {
            // Missing (expired session, process gone) — stays pending. If the
            // app re-creates the session later, Windows hands it the ducked
            // volume it remembered, and a retry heals it via pid/exe matching.
            continue;
        };
        consumed[index] = true;
        let session = &sessions[index];
        // SAFETY: `session.volume` is a live WASAPI interface obtained during enumeration.
        let Ok(current) = (unsafe { session.volume.GetMasterVolume() }) else {
            continue;
        };
        if !volume_still_ours(current, snapshot.ducked_to) {
            // Robustness rule 3: the slider moved while we were ducked (user or
            // app) — leave it exactly where it is and consider the snapshot
            // settled; rewriting would stomp their change.
            resolved.push(snapshot.key.clone());
            continue;
        }
        // SAFETY: `session.volume` is valid and `snapshot.previous` was read from
        // the same API before ducking (already clamped by WASAPI).
        if unsafe {
            session
                .volume
                .SetMasterVolume(snapshot.previous, std::ptr::null())
                .is_err()
        } {
            continue;
        }
        // Trust nothing: only a read-back at the written value counts (rule 5).
        match unsafe { session.volume.GetMasterVolume() } {
            Ok(now) if (now - snapshot.previous).abs() <= RESTORE_TOLERANCE => {
                resolved.push(snapshot.key.clone());
            }
            _ => {}
        }
    }

    resolved
}

/// Locate the session a snapshot belongs to: exact instance id first, then the
/// recorded pid (session re-created by the same process), then the recorded
/// executable name (session re-created by a NEW process of the same app —
/// browser audio-service churn, app restarts). The pid/exe tiers only consider
/// sessions not already claimed by another snapshot, and every match is still
/// guarded by `volume_still_ours` before anything is written.
#[cfg(windows)]
fn find_session_for_snapshot(
    sessions: &[AudioSessionVolume],
    consumed: &[bool],
    snapshot: &SessionVolumeSnapshot,
    exe_cache: &mut std::collections::HashMap<u32, Option<String>>,
) -> Option<usize> {
    if let Some(index) = sessions
        .iter()
        .enumerate()
        .find(|(index, session)| !consumed[*index] && session.key == snapshot.key)
        .map(|(index, _)| index)
    {
        return Some(index);
    }
    if snapshot.pid != 0
        && let Some(index) = sessions
            .iter()
            .enumerate()
            .find(|(index, session)| !consumed[*index] && session.pid == snapshot.pid)
            .map(|(index, _)| index)
    {
        return Some(index);
    }
    let exe = snapshot.exe.as_deref()?;
    sessions
        .iter()
        .enumerate()
        .find(|(index, session)| {
            !consumed[*index]
                && session.pid != 0
                && exe_cache
                    .entry(session.pid)
                    .or_insert_with(|| process_image_name(session.pid))
                    .as_deref()
                    == Some(exe)
        })
        .map(|(index, _)| index)
}

/// Lower-cased executable file name for a pid ("chrome.exe"), or None when the
/// process is gone or unqueryable. Least-privilege query handle, closed on
/// every path.
#[cfg(windows)]
fn process_image_name(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };

    // SAFETY: the handle is opened with a query-only right and closed on every
    // path; `buffer`/`length` follow the API's in/out length protocol.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 512];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(handle);
        if result.is_err() || length == 0 {
            return None;
        }
        let full = String::from_utf16_lossy(&buffer[..length as usize]);
        std::path::Path::new(&full)
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_lowercase)
    }
}

// Non-Windows stubs so the manager wiring compiles cross-platform. System-audio
// ducking is currently implemented only through the Windows session-volume APIs,
// so it is a no-op elsewhere.
#[cfg(not(windows))]
fn perform_session_duck(_reduction_pct: u8) -> Option<Vec<SessionVolumeSnapshot>> {
    None
}

#[cfg(not(windows))]
fn perform_verified_session_restore(snapshots: &[SessionVolumeSnapshot]) -> Option<Vec<String>> {
    Some(snapshots.iter().map(|s| s.key.clone()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn snap(key: &str, pid: u32, previous: f32, ducked_to: f32) -> SessionVolumeSnapshot {
        SessionVolumeSnapshot {
            key: key.to_string(),
            pid,
            exe: None,
            previous,
            ducked_to,
        }
    }

    /// Scripted result for one `restore` call.
    enum RestoreScript {
        /// The session enumeration itself failed → `None`.
        EnumerationFails,
        /// Only these keys verify; the rest stay unresolved.
        Resolves(Vec<&'static str>),
    }

    /// Records every side effect instead of touching COM / the filesystem.
    #[derive(Default)]
    struct MockOps {
        /// What the next duck enumeration returns (None = COM failure).
        duck_result: Option<Vec<SessionVolumeSnapshot>>,
        /// Consumed per restore call; once empty, every call verifies ALL of
        /// the requested keys (the happy path).
        restore_script: VecDeque<RestoreScript>,
        ducks: u32,
        restores: Vec<Vec<SessionVolumeSnapshot>>,
        persisted: Option<Vec<SessionVolumeSnapshot>>,
        journal_clears: u32,
        call_log: Vec<&'static str>,
    }

    impl MockOps {
        fn with_sessions(snapshots: Vec<SessionVolumeSnapshot>) -> Self {
            Self {
                duck_result: Some(snapshots),
                ..Self::default()
            }
        }
    }

    impl DuckOps for MockOps {
        fn duck(&mut self, _reduction_pct: u8) -> Option<Vec<SessionVolumeSnapshot>> {
            self.call_log.push("duck");
            self.ducks += 1;
            self.duck_result.clone()
        }

        fn restore(&mut self, snapshots: &[SessionVolumeSnapshot]) -> Option<Vec<String>> {
            self.call_log.push("restore");
            self.restores.push(snapshots.to_vec());
            match self.restore_script.pop_front() {
                Some(RestoreScript::EnumerationFails) => None,
                Some(RestoreScript::Resolves(keys)) => {
                    Some(keys.into_iter().map(String::from).collect())
                }
                None => Some(snapshots.iter().map(|s| s.key.clone()).collect()),
            }
        }

        fn persist(&mut self, snapshots: &[SessionVolumeSnapshot]) {
            self.persisted = Some(snapshots.to_vec());
        }

        fn clear_persisted(&mut self) {
            self.persisted = None;
            self.journal_clears += 1;
        }
    }

    fn alive(flag: &Arc<AtomicBool>) -> Liveness {
        let flag = Arc::clone(flag);
        Arc::new(move || flag.load(Ordering::SeqCst))
    }

    /// Backdate a reason so the watchdog's grace period has elapsed.
    fn expire_grace(state: &mut WorkerState) {
        for reason in &mut state.active {
            reason.since = Instant::now()
                .checked_sub(REAP_GRACE + Duration::from_secs(1))
                .expect("system uptime exceeds the reap grace");
        }
    }

    /// Backdate the pending pool's last attempt past the retry interval.
    fn expire_pending_interval(state: &mut WorkerState) {
        state.pending_last_attempt = Instant::now()
            .checked_sub(PENDING_RETRY_INTERVAL + Duration::from_secs(1))
            .map(Some)
            .expect("system uptime exceeds the pending retry interval");
    }

    // ── reduction math ──

    #[test]
    fn full_mute_at_100_pct() {
        assert_eq!(reduction_target(0.8, 100), 0.0);
    }

    #[test]
    fn no_change_at_0_pct() {
        assert!((reduction_target(0.8, 0) - 0.8).abs() < 1e-6);
    }

    #[test]
    fn partial_duck_attenuates() {
        // pct=80 → 20% of previous
        assert!((reduction_target(0.5, 80) - 0.1).abs() < 1e-6);
    }

    #[test]
    fn reduction_clamped_to_unit_range() {
        assert_eq!(reduction_target(2.0, 0), 1.0); // clamps high
        assert_eq!(reduction_target(-1.0, 0), 0.0); // clamps low
        // pct above 100 is clamped to 100 → full mute
        assert_eq!(reduction_target(0.9, 200), 0.0);
    }

    #[test]
    fn clamp_handles_nan() {
        assert_eq!(clamp_scalar(f32::NAN), 0.0);
        assert_eq!(clamp_scalar(1.5), 1.0);
        assert_eq!(clamp_scalar(-0.5), 0.0);
    }

    // ── volume parsing ──

    #[test]
    fn parse_volume_tolerates_comma_and_whitespace() {
        assert_eq!(parse_volume("0.5"), Some(0.5));
        assert_eq!(parse_volume(" 0,75 "), Some(0.75));
        assert_eq!(parse_volume("not a number"), None);
        // out-of-range clamps
        assert_eq!(parse_volume("1.2"), Some(1.0));
    }

    // ── restore guard ──

    #[cfg(windows)]
    #[test]
    fn restore_guard_tolerates_float_drift_but_not_user_moves() {
        assert!(volume_still_ours(0.2, 0.2));
        assert!(volume_still_ours(0.21, 0.2)); // WASAPI float round-trip
        assert!(!volume_still_ours(0.6, 0.2)); // user raised the slider mid-duck
    }

    // ── journal (de)serialization compatibility ──

    #[test]
    fn journal_without_exe_field_still_deserializes() {
        // Journals written by builds that predate the `exe` matcher.
        let legacy = r#"[{"key":"a","pid":10,"previous":0.8,"ducked_to":0.16}]"#;
        let parsed: Vec<SessionVolumeSnapshot> =
            serde_json::from_str(legacy).expect("legacy journal parses");
        assert_eq!(parsed, vec![snap("a", 10, 0.8, 0.16)]);
    }

    // ── ledger transitions ──

    #[test]
    fn duck_then_restore_full_cycle() {
        let mut state = WorkerState::default();
        let sessions = vec![snap("a", 10, 0.8, 0.16), snap("b", 20, 0.5, 0.1)];
        let mut ops = MockOps::with_sessions(sessions.clone());

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        assert!(state.ducked);
        assert_eq!(ops.ducks, 1);
        // journal written while ducked (crash recovery).
        assert_eq!(ops.persisted.as_deref(), Some(sessions.as_slice()));

        handle_restore(&mut state, &mut ops, DuckReason::Dictation);
        assert!(!state.ducked);
        assert!(state.pending_restore.is_empty());
        assert_eq!(ops.restores, vec![sessions]);
        assert!(ops.persisted.is_none());

        // a second restore is a no-op (nothing left ducked).
        handle_restore(&mut state, &mut ops, DuckReason::Dictation);
        assert_eq!(ops.restores.len(), 1);
    }

    #[test]
    fn second_reason_piggybacks_and_restore_waits_for_all() {
        let mut state = WorkerState::default();
        let mut ops = MockOps::with_sessions(vec![snap("a", 7, 0.9, 0.09)]);

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 90, None, false);
        handle_duck(&mut state, &mut ops, DuckReason::ReadAloud, 90, None, false);
        // duplicate request for an already-active reason is also a no-op.
        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 90, None, false);
        assert_eq!(ops.ducks, 1);

        // dictation releasing first keeps the duck (Read Aloud still wants it).
        handle_restore(&mut state, &mut ops, DuckReason::Dictation);
        assert!(state.ducked);
        assert!(ops.restores.is_empty());

        handle_restore(&mut state, &mut ops, DuckReason::ReadAloud);
        assert!(!state.ducked);
        assert_eq!(ops.restores.len(), 1);
    }

    #[test]
    fn gated_duck_skips_when_recording_already_stopped() {
        // Models the fast-tap TOCTOU: the stop's restore was processed BEFORE
        // this duck job, so the liveness gate must veto the duck entirely.
        let mut state = WorkerState::default();
        let mut ops = MockOps::with_sessions(vec![snap("a", 3, 0.4, 0.08)]);
        let recording = Arc::new(AtomicBool::new(false));

        handle_restore(&mut state, &mut ops, DuckReason::Dictation); // stop landed first
        handle_duck(
            &mut state,
            &mut ops,
            DuckReason::Dictation,
            80,
            Some(alive(&recording)),
            true,
        );

        assert!(!state.ducked);
        assert!(state.active.is_empty());
        assert_eq!(ops.ducks, 0);
    }

    #[test]
    fn gated_duck_proceeds_while_recording_live() {
        let mut state = WorkerState::default();
        let mut ops = MockOps::with_sessions(vec![snap("a", 3, 0.4, 0.08)]);
        let recording = Arc::new(AtomicBool::new(true));

        handle_duck(
            &mut state,
            &mut ops,
            DuckReason::Dictation,
            80,
            Some(alive(&recording)),
            true,
        );
        assert!(state.ducked);
        assert_eq!(ops.ducks, 1);
    }

    #[test]
    fn watchdog_reaps_dead_reason_after_grace_and_restores() {
        let mut state = WorkerState::default();
        let mut ops = MockOps::with_sessions(vec![snap("a", 3, 0.4, 0.08)]);
        let recording = Arc::new(AtomicBool::new(true));

        handle_duck(
            &mut state,
            &mut ops,
            DuckReason::Dictation,
            80,
            Some(alive(&recording)),
            true,
        );

        // Within the grace period nothing is reaped even if liveness dies.
        recording.store(false, Ordering::SeqCst);
        watchdog_tick(&mut state, &mut ops);
        assert!(state.ducked);

        // Past the grace period the dead reason is released and audio restored.
        expire_grace(&mut state);
        watchdog_tick(&mut state, &mut ops);
        assert!(!state.ducked);
        assert_eq!(ops.restores.len(), 1);
    }

    #[test]
    fn watchdog_leaves_live_reasons_alone() {
        let mut state = WorkerState::default();
        let mut ops = MockOps::with_sessions(vec![snap("a", 3, 0.4, 0.08)]);
        let recording = Arc::new(AtomicBool::new(true));

        handle_duck(
            &mut state,
            &mut ops,
            DuckReason::Dictation,
            80,
            Some(alive(&recording)),
            true,
        );
        expire_grace(&mut state);
        watchdog_tick(&mut state, &mut ops);

        assert!(state.ducked);
        assert!(ops.restores.is_empty());
    }

    #[test]
    fn duplicate_duck_refreshes_liveness_probe() {
        // A new recording's duck arrives while the previous cycle's reason is
        // still held (its restore was lost). The refreshed probe must keep the
        // watchdog from reaping the duck out from under the LIVE recording.
        let mut state = WorkerState::default();
        let mut ops = MockOps::with_sessions(vec![snap("a", 3, 0.4, 0.08)]);
        let first = Arc::new(AtomicBool::new(true));
        let second = Arc::new(AtomicBool::new(true));

        handle_duck(
            &mut state,
            &mut ops,
            DuckReason::Dictation,
            80,
            Some(alive(&first)),
            true,
        );
        first.store(false, Ordering::SeqCst); // first cycle is over
        handle_duck(
            &mut state,
            &mut ops,
            DuckReason::Dictation,
            80,
            Some(alive(&second)),
            true,
        );
        assert_eq!(ops.ducks, 1); // still one COM duck (piggyback on itself)

        // The stale first-probe would have been reaped here; the refreshed
        // probe reports the live recording and holds the duck.
        expire_grace(&mut state);
        watchdog_tick(&mut state, &mut ops);
        assert!(state.ducked);
        assert!(ops.restores.is_empty());

        // Once the second recording ends too, the watchdog releases it.
        second.store(false, Ordering::SeqCst);
        expire_grace(&mut state);
        watchdog_tick(&mut state, &mut ops);
        assert!(!state.ducked);
        assert_eq!(ops.restores.len(), 1);
    }

    #[test]
    fn enumeration_failure_keeps_snapshots_and_watchdog_retries() {
        let mut state = WorkerState::default();
        let sessions = vec![snap("a", 3, 0.4, 0.08)];
        let mut ops = MockOps::with_sessions(sessions.clone());
        ops.restore_script
            .push_back(RestoreScript::EnumerationFails);

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        handle_restore(&mut state, &mut ops, DuckReason::Dictation);

        // Restore never ran: still ducked, snapshots retained, journal intact.
        assert!(state.ducked);
        assert_eq!(state.snapshots, sessions);
        assert!(ops.persisted.is_some());

        // The watchdog retries once the audio service recovers — no reason
        // holds the duck, so `ducked && idle` alone triggers the retry.
        watchdog_tick(&mut state, &mut ops);
        assert!(!state.ducked);
        assert_eq!(ops.restores.len(), 2);
        assert!(ops.persisted.is_none());
    }

    #[test]
    fn partial_restore_parks_unresolved_and_watchdog_heals() {
        // THE bug class behind "volume stays muted after dictation": one
        // session's restore cannot be verified (missing / failed write). It
        // must survive as pending + journaled work, not be silently dropped.
        let mut state = WorkerState::default();
        let sessions = vec![snap("a", 10, 0.8, 0.16), snap("b", 20, 0.5, 0.1)];
        let mut ops = MockOps::with_sessions(sessions);
        ops.restore_script
            .push_back(RestoreScript::Resolves(vec!["a"]));

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        handle_restore(&mut state, &mut ops, DuckReason::Dictation);

        // The duck is over, but "b" is parked for healing and stays journaled.
        assert!(!state.ducked);
        assert_eq!(state.pending_restore, vec![snap("b", 20, 0.5, 0.1)]);
        assert_eq!(
            ops.persisted.as_deref(),
            Some(&[snap("b", 20, 0.5, 0.1)][..])
        );

        // Not retried again before the interval elapses…
        watchdog_tick(&mut state, &mut ops);
        assert_eq!(ops.restores.len(), 1);

        // …but healed once it does (session came back / write now verifies).
        expire_pending_interval(&mut state);
        watchdog_tick(&mut state, &mut ops);
        assert!(state.pending_restore.is_empty());
        assert_eq!(ops.restores.len(), 2);
        assert_eq!(ops.restores[1], vec![snap("b", 20, 0.5, 0.1)]);
        assert!(ops.persisted.is_none());
    }

    #[test]
    fn pending_is_healed_before_the_next_duck() {
        // Anti-ratchet + un-stick: a session left ducked by a failed cycle is
        // restored BEFORE the next duck snapshots it again, so the duck never
        // captures a ducked level as "previous" and the stuck volume heals at
        // the next dictation even without waiting for the watchdog.
        let mut state = WorkerState::default();
        let sessions = vec![snap("a", 10, 0.8, 0.16)];
        let mut ops = MockOps::with_sessions(sessions.clone());
        ops.restore_script
            .push_back(RestoreScript::Resolves(vec![]));

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        handle_restore(&mut state, &mut ops, DuckReason::Dictation);
        assert_eq!(state.pending_restore, sessions);

        ops.call_log.clear();
        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);

        // Heal ran first (default script = verifies all), THEN the fresh duck.
        assert_eq!(ops.call_log, vec!["restore", "duck"]);
        assert!(state.pending_restore.is_empty());
        assert!(state.ducked);
        assert_eq!(state.snapshots, sessions);
    }

    #[test]
    fn reduck_while_restore_never_ran_keeps_original_snapshots() {
        // The anti-ratchet invariant for a WHOLLY failed restore (enumeration
        // down): a new duck while the old snapshots are still live must NOT
        // re-snapshot the ducked levels.
        let mut state = WorkerState::default();
        let original = vec![snap("a", 3, 0.4, 0.08)];
        let mut ops = MockOps::with_sessions(original.clone());
        ops.restore_script
            .push_back(RestoreScript::EnumerationFails);

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        handle_restore(&mut state, &mut ops, DuckReason::Dictation);
        assert!(state.ducked); // restore never ran

        // Next PTT press arrives before the retry succeeded → piggyback.
        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        assert_eq!(ops.ducks, 1); // no second COM duck
        assert_eq!(state.snapshots, original); // originals preserved

        handle_restore(&mut state, &mut ops, DuckReason::Dictation);
        assert!(!state.ducked);
        assert_eq!(ops.restores.last(), Some(&original));
    }

    #[test]
    fn watchdog_recovers_a_duck_orphaned_by_a_panicked_job() {
        // A restore job that panicked after removing its reason leaves
        // `ducked` with no owner and no flags. The watchdog's `ducked && idle`
        // check must still put the mixer back.
        let mut state = WorkerState::default();
        let sessions = vec![snap("a", 3, 0.4, 0.08)];
        let mut ops = MockOps::with_sessions(sessions.clone());

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        state.active.clear(); // as if the reason was released but restore died

        watchdog_tick(&mut state, &mut ops);
        assert!(!state.ducked);
        assert_eq!(ops.restores, vec![sessions]);
        assert!(ops.persisted.is_none());
    }

    #[test]
    fn duck_com_failure_leaves_nothing_to_restore() {
        let mut state = WorkerState::default();
        let mut ops = MockOps {
            duck_result: None,
            ..MockOps::default()
        };

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        assert!(!state.ducked);
        assert!(ops.persisted.is_none());

        handle_restore(&mut state, &mut ops, DuckReason::Dictation);
        assert!(ops.restores.is_empty());
    }

    #[test]
    fn empty_snapshot_capture_still_clears_state() {
        // COM duck found no background sessions: no snapshots, and a later
        // restore is a clean no-op rather than a leak.
        let mut state = WorkerState::default();
        let mut ops = MockOps::with_sessions(Vec::new());

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        assert!(state.ducked);

        handle_restore(&mut state, &mut ops, DuckReason::Dictation);
        assert!(!state.ducked);
        // No sessions were lowered, so no restore write happened either.
        assert!(ops.restores.is_empty());
    }

    #[test]
    fn restore_all_releases_every_reason_and_heals_pending() {
        let mut state = WorkerState::default();
        let sessions = vec![snap("a", 3, 0.4, 0.08)];
        let mut ops = MockOps::with_sessions(sessions.clone());

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        handle_duck(&mut state, &mut ops, DuckReason::ReadAloud, 80, None, false);
        state.pending_restore.push(snap("z", 99, 0.7, 0.0));

        handle_restore_all(&mut state, &mut ops);
        assert!(!state.ducked);
        assert!(state.pending_restore.is_empty());
        // Live snapshots restored, then the pending pool healed.
        assert_eq!(ops.restores.len(), 2);
        assert_eq!(ops.restores[0], sessions);
        assert_eq!(ops.restores[1], vec![snap("z", 99, 0.7, 0.0)]);
        assert!(ops.persisted.is_none());
    }

    #[test]
    fn orphans_join_pending_without_clobbering_a_live_journal() {
        // Startup recovery racing the first dictation: the orphaned snapshots
        // must merge into the pending pool and the journal must keep BOTH the
        // live duck and the unresolved orphans (the old code deleted it).
        let mut state = WorkerState::default();
        let live = vec![snap("a", 3, 0.4, 0.08)];
        let mut ops = MockOps::with_sessions(live);

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        ops.restore_script
            .push_back(RestoreScript::Resolves(vec![])); // orphan not back yet
        handle_restore_orphaned(&mut state, &mut ops, vec![snap("z", 99, 0.7, 0.0)]);

        assert!(state.ducked);
        assert_eq!(state.pending_restore, vec![snap("z", 99, 0.7, 0.0)]);
        assert_eq!(
            ops.persisted.as_deref(),
            Some(&[snap("a", 3, 0.4, 0.08), snap("z", 99, 0.7, 0.0)][..])
        );
    }

    #[test]
    fn orphans_heal_immediately_when_their_sessions_are_back() {
        let mut state = WorkerState::default();
        let mut ops = MockOps::default(); // default restore verifies everything

        handle_restore_orphaned(&mut state, &mut ops, vec![snap("z", 99, 0.7, 0.0)]);

        assert!(state.pending_restore.is_empty());
        assert_eq!(ops.restores, vec![vec![snap("z", 99, 0.7, 0.0)]]);
        assert!(ops.persisted.is_none());
    }

    #[test]
    fn pending_dedupe_keeps_the_older_entry() {
        // The older entry's `previous` predates our interference and is the
        // user's true volume; a later duplicate must not overwrite it.
        let mut state = WorkerState::default();
        push_pending(&mut state, snap("a", 3, 0.8, 0.0));
        push_pending(&mut state, snap("a", 3, 0.1, 0.0));
        assert_eq!(state.pending_restore, vec![snap("a", 3, 0.8, 0.0)]);
    }
}

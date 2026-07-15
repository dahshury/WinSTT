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
//   5. Restore retry. A failed session enumeration during restore keeps the
//      snapshots and retries from the watchdog rather than dropping them.
//   6. Crash persistence. Snapshots are journaled to disk while ducked and the
//      journal is deleted after a successful restore. The next launch restores
//      any sessions a crashed/killed run left ducked (guarded by rule 3).
//   7. Exit hook. `restore_all_blocking_on_exit` runs from Tauri's
//      ExitRequested cleanup so a graceful quit mid-dictation restores
//      synchronously (bounded wait).
//
// The reduction/clamp/ledger logic is pure and fully tested (COM is abstracted
// behind `DuckOps`); the only unverifiable bit is runtime COM behavior.

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
/// with the pid kept as a fallback matcher for sessions the process re-created
/// mid-duck.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct SessionVolumeSnapshot {
    /// Session instance identifier, or `"pid:<n>"` when unavailable.
    key: String,
    pid: u32,
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
    /// A restore was due but the COM enumeration failed — retry from the
    /// watchdog instead of dropping the snapshots.
    restore_pending: bool,
}

/// The side-effect surface of the ledger, so the transition logic is testable
/// without COM or a filesystem.
trait DuckOps {
    /// Capture + lower background sessions. `None` = enumeration failed.
    fn duck(&mut self, reduction_pct: u8) -> Option<Vec<SessionVolumeSnapshot>>;
    /// Put sessions back. `false` = enumeration failed even after retries.
    fn restore(&mut self, snapshots: &[SessionVolumeSnapshot]) -> bool;
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

fn handle_duck(
    state: &mut WorkerState,
    ops: &mut impl DuckOps,
    reason: DuckReason,
    reduction_pct: u8,
    liveness: Option<Liveness>,
    gate_before_duck: bool,
) {
    if state.active.iter().any(|a| a.reason == reason) {
        return;
    }
    // Robustness rule 2: the authoritative "still wanted?" check runs HERE, on
    // the worker, after every previously queued restore has fully applied. A
    // recording whose stop already landed (fast PTT tap) is not ducked at all.
    if gate_before_duck && liveness.as_ref().is_some_and(|alive| !alive()) {
        log::debug!("[ducking] duck for {reason:?} skipped -- no longer wanted");
        return;
    }
    state.active.push(ActiveReason {
        reason,
        liveness,
        since: Instant::now(),
    });
    if state.ducked {
        // Piggyback on the existing duck. This also covers re-ducking while a
        // failed restore's snapshots are still held: we keep the ORIGINAL
        // pre-duck volumes and never re-snapshot already-ducked levels.
        state.restore_pending = false;
        return;
    }
    match ops.duck(reduction_pct) {
        Some(snapshots) => {
            state.ducked = true;
            ops.persist(&snapshots);
            state.snapshots = snapshots;
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
    if state.snapshots.is_empty() || ops.restore(&state.snapshots) {
        state.ducked = false;
        state.snapshots.clear();
        state.restore_pending = false;
        ops.clear_persisted();
    } else {
        // Robustness rule 5: keep the snapshots; the watchdog retries.
        state.restore_pending = true;
        log::warn!("[ducking] restore failed; keeping snapshots and retrying from the watchdog");
    }
}

fn watchdog_tick(state: &mut WorkerState, ops: &mut impl DuckOps) {
    if state.restore_pending && state.active.is_empty() {
        try_restore_if_idle(state, ops);
        return;
    }
    if state.active.is_empty() {
        return;
    }
    // Robustness rule 4: a reason whose terminal event was lost (pipeline
    // panic, dropped emit) must not hold the user's mixer down forever. Past
    // the grace period, a reason whose liveness probe says "no longer wanted"
    // is force-released. Reasons without a probe are only released by their
    // explicit restore or the exit hook.
    let before = state.active.len();
    state.active.retain(|a| {
        a.since.elapsed() < REAP_GRACE || a.liveness.as_ref().is_none_or(|alive| alive())
    });
    if state.active.len() < before {
        log::warn!(
            "[ducking] watchdog released {} stale duck reason(s) whose restore never arrived",
            before - state.active.len()
        );
        try_restore_if_idle(state, ops);
    }
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
    /// Startup: best-effort restore of sessions a previous (crashed) run left
    /// ducked, from the on-disk journal.
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
    let mut state = WorkerState::default();
    let mut ops = RealOps;
    loop {
        match rx.recv_timeout(WATCHDOG_TICK) {
            Ok(job) => handle_job(&mut state, &mut ops, job),
            Err(mpsc::RecvTimeoutError::Timeout) => watchdog_tick(&mut state, &mut ops),
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
            state.active.clear();
            try_restore_if_idle(state, ops);
            if let Some(ack) = ack {
                let _ = ack.send(());
            }
        }
        ComJob::RestoreOrphaned { snapshots } => {
            // Only meaningful while nothing live owns the mixer. The
            // volume_still_ours guard inside the restore keeps this safe even
            // if the journal is stale.
            if !state.ducked && state.active.is_empty() {
                log::info!(
                    "[ducking] restoring {} session volume(s) left ducked by a previous run",
                    snapshots.len()
                );
                let _ = ops.restore(&snapshots);
            }
            ops.clear_persisted();
        }
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

/// Wire the crash-recovery journal path and restore any duck a previous run
/// left behind (crash / kill / power loss while dictating). Call once during
/// startup, before the first dictation.
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

    fn restore(&mut self, snapshots: &[SessionVolumeSnapshot]) -> bool {
        perform_session_restore_with_retry(snapshots)
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
// Enumerates the default render endpoint's audio sessions and lowers each one
// that does NOT belong to WinSTT or its child processes. Returns None on any COM
// failure (the caller treats that as "nothing ducked").

#[cfg(windows)]
struct AudioSessionVolume {
    key: String,
    pid: u32,
    volume: windows::Win32::Media::Audio::ISimpleAudioVolume,
}

/// The set of process ids to leave alone: WinSTT itself plus every descendant
/// process (WebView2 children, etc.). The in-process rodio recording chime and
/// the overlay-WebView Read Aloud audio both live inside this tree, so neither
/// is ducked.
#[cfg(windows)]
fn protected_winstt_process_ids() -> std::collections::HashSet<u32> {
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

    protected
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

#[cfg(windows)]
fn enumerate_audio_session_volumes() -> Option<Vec<AudioSessionVolume>> {
    use windows::Win32::Media::Audio::{
        IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume,
        MMDeviceEnumerator, eMultimedia, eRender,
    };
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
    use windows::core::Interface;

    let _com = crate::windows_com::ComApartment::init_multithreaded();
    // SAFETY: COM is initialized for this thread and each interface returned by WASAPI is
    // checked before use; interface values are kept within this thread-local enumeration.
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .ok()?;
        let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None).ok()?;
        let sessions = manager.GetSessionEnumerator().ok()?;
        let count = sessions.GetCount().ok()?;
        let mut volumes = Vec::new();

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

        Some(volumes)
    }
}

/// Duck every audio session that does NOT belong to WinSTT's process tree, and
/// return the captured pre-duck volumes so a later restore can put them back.
#[cfg(windows)]
fn perform_session_duck(reduction_pct: u8) -> Option<Vec<SessionVolumeSnapshot>> {
    let protected = protected_winstt_process_ids();
    let sessions = enumerate_audio_session_volumes()?;
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
            // change, so nothing to snapshot or restore either.
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
                key: session.key,
                pid: session.pid,
                previous: current,
                ducked_to: target,
            });
        }
    }

    Some(snapshots)
}

/// Restore, retrying the session enumeration a few times (an audio-service
/// hiccup or device switch mid-restore must not silently drop the snapshots).
/// Returns false when every attempt failed — the ledger keeps the snapshots.
#[cfg(windows)]
fn perform_session_restore_with_retry(snapshots: &[SessionVolumeSnapshot]) -> bool {
    for attempt in 0..3u32 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(150 * u64::from(attempt)));
        }
        if let Some(sessions) = enumerate_audio_session_volumes() {
            apply_session_restore(&sessions, snapshots);
            return true;
        }
    }
    false
}

#[cfg(windows)]
fn apply_session_restore(sessions: &[AudioSessionVolume], snapshots: &[SessionVolumeSnapshot]) {
    for session in sessions {
        // SAFETY: `session.volume` is a live WASAPI interface obtained during enumeration.
        let Ok(current) = (unsafe { session.volume.GetMasterVolume() }) else {
            continue;
        };
        let snapshot = snapshots.iter().find(|s| s.key == session.key).or_else(|| {
            // The process re-created its session mid-duck (new instance id)
            // but inherited the ducked per-app volume Windows remembers.
            snapshots
                .iter()
                .find(|s| s.pid != 0 && s.pid == session.pid)
        });
        let Some(snapshot) = snapshot else {
            continue;
        };
        // Robustness rule 3: only undo what we did. A slider the user (or
        // another app) moved while we were ducked is left exactly where it is.
        if !volume_still_ours(current, snapshot.ducked_to) {
            continue;
        }
        // SAFETY: `session.volume` is valid and `snapshot.previous` was read from
        // the same API before ducking (already clamped by WASAPI).
        let _ = unsafe {
            session
                .volume
                .SetMasterVolume(snapshot.previous, std::ptr::null())
        };
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
fn perform_session_restore_with_retry(_snapshots: &[SessionVolumeSnapshot]) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn snap(key: &str, pid: u32, previous: f32, ducked_to: f32) -> SessionVolumeSnapshot {
        SessionVolumeSnapshot {
            key: key.to_string(),
            pid,
            previous,
            ducked_to,
        }
    }

    /// Records every side effect instead of touching COM / the filesystem.
    #[derive(Default)]
    struct MockOps {
        /// What the next duck enumeration returns (None = COM failure).
        duck_result: Option<Vec<SessionVolumeSnapshot>>,
        restore_ok: bool,
        ducks: u32,
        restores: Vec<Vec<SessionVolumeSnapshot>>,
        persisted: Option<Vec<SessionVolumeSnapshot>>,
        journal_clears: u32,
    }

    impl MockOps {
        fn with_sessions(snapshots: Vec<SessionVolumeSnapshot>) -> Self {
            Self {
                duck_result: Some(snapshots),
                restore_ok: true,
                ..Self::default()
            }
        }
    }

    impl DuckOps for MockOps {
        fn duck(&mut self, _reduction_pct: u8) -> Option<Vec<SessionVolumeSnapshot>> {
            self.ducks += 1;
            self.duck_result.clone()
        }

        fn restore(&mut self, snapshots: &[SessionVolumeSnapshot]) -> bool {
            if self.restore_ok {
                self.restores.push(snapshots.to_vec());
            }
            self.restore_ok
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
    fn failed_restore_keeps_snapshots_and_watchdog_retries() {
        let mut state = WorkerState::default();
        let sessions = vec![snap("a", 3, 0.4, 0.08)];
        let mut ops = MockOps::with_sessions(sessions.clone());
        ops.restore_ok = false;

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        handle_restore(&mut state, &mut ops, DuckReason::Dictation);

        // Restore failed: still ducked, snapshots retained, journal intact.
        assert!(state.ducked);
        assert!(state.restore_pending);
        assert_eq!(state.snapshots, sessions);
        assert!(ops.persisted.is_some());

        // The watchdog retries once the audio service recovers.
        ops.restore_ok = true;
        watchdog_tick(&mut state, &mut ops);
        assert!(!state.ducked);
        assert_eq!(ops.restores, vec![sessions]);
        assert!(ops.persisted.is_none());
    }

    #[test]
    fn reduck_after_failed_restore_keeps_original_snapshots() {
        // The anti-ratchet invariant: a new duck while old (failed-restore)
        // snapshots are still held must NOT re-snapshot the ducked levels.
        let mut state = WorkerState::default();
        let original = vec![snap("a", 3, 0.4, 0.08)];
        let mut ops = MockOps::with_sessions(original.clone());
        ops.restore_ok = false;

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        handle_restore(&mut state, &mut ops, DuckReason::Dictation);
        assert!(state.restore_pending);

        // Next PTT press arrives before the retry succeeded.
        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        assert_eq!(ops.ducks, 1); // no second COM duck
        assert_eq!(state.snapshots, original); // originals preserved
        assert!(!state.restore_pending);

        ops.restore_ok = true;
        handle_restore(&mut state, &mut ops, DuckReason::Dictation);
        assert_eq!(ops.restores, vec![original]);
    }

    #[test]
    fn duck_com_failure_leaves_nothing_to_restore() {
        let mut state = WorkerState::default();
        let mut ops = MockOps {
            duck_result: None,
            restore_ok: true,
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
    fn restore_all_releases_every_reason() {
        let mut state = WorkerState::default();
        let sessions = vec![snap("a", 3, 0.4, 0.08)];
        let mut ops = MockOps::with_sessions(sessions.clone());

        handle_duck(&mut state, &mut ops, DuckReason::Dictation, 80, None, false);
        handle_duck(&mut state, &mut ops, DuckReason::ReadAloud, 80, None, false);

        // The exit hook clears all reasons at once.
        state.active.clear();
        try_restore_if_idle(&mut state, &mut ops);
        assert!(!state.ducked);
        assert_eq!(ops.restores, vec![sessions]);
    }
}

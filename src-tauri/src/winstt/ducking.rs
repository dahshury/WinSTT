// Source: app/src-tauri/src/managers/audio.rs (the COM session enumeration
// pattern, plus reduction math + two-layer duck/restore latch).
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
// recording chime, which plays in-process through rodio. The old code worked
// around this by playing the chime first and ducking afterwards, which is
// exactly the lag the user noticed.
//
// Instead we duck PER SESSION (`ISimpleAudioVolume` on every audio session of
// the default render endpoint) and PROTECT WinSTT's own process tree (the main
// process + its WebView2 children + the in-process rodio chime). Background
// apps (music, video, browser tabs) drop to the configured level; WinSTT's own
// chime and Read Aloud TTS stay at full volume. With the chime protected we can
// now duck FIRST and then play the chime.
//
// Ported faithfully from audio-mute.ts:
//   - reductionTarget(volume, pct) math + clamp [0,1].
//   - parseVolume scalar parsing tolerance.
//   - the two-layer intent-vs-effect latch (here: `active_reasons` intent vs
//     `ducked`+`snapshots` effect) so an unmute that races an in-flight duck
//     still restores. Generalized to a reason bitmask so Dictation and Read
//     Aloud reference-count one shared session-duck (first reason captures the
//     snapshots; the last reason to release restores them).
//
// The reduction/clamp/state math is PURE and fully tested. The COM read/set is a
// real Windows impl modeled on the existing session-volume path (the only
// unverifiable bit is runtime COM behavior, which the compile loop confirms).

use std::sync::{Mutex, OnceLock};

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

// ───────────────────── reason-counted session-duck state ───────────────────
//
// `active_reasons` = features currently asking for background audio to stay
// ducked (intent). `ducked` + `snapshots` = we actually enumerated the sessions,
// captured their previous volumes, and lowered them (effect). They diverge while
// a COM call is "in flight"; the latch ensures a restore that races a pending
// duck still tears it down.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuckReason {
    Dictation,
    ReadAloud,
}

impl DuckReason {
    fn bit(self) -> u8 {
        match self {
            Self::Dictation => 0b0000_0001,
            Self::ReadAloud => 0b0000_0010,
        }
    }
}

/// Whether the caller should perform the COM duck for this request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionDuckAction {
    /// Transitioned from idle — capture snapshots and lower the sessions.
    Duck,
    /// Another reason already ducked (or this one already had); piggyback.
    NoOp,
}

/// One session's pre-duck volume, keyed by owning process id, so a restore can
/// match it back up after re-enumerating (session COM objects are not stable
/// across enumerations).
#[derive(Debug, Clone, Copy, PartialEq)]
struct SessionVolumeSnapshot {
    pid: u32,
    volume: f32,
}

#[derive(Debug, Default)]
struct SessionDuckState {
    /// Intent: features currently asking background audio to stay ducked.
    active_reasons: u8,
    /// Effect: we issued the duck and captured the previous session volumes.
    ducked: bool,
    /// The captured pre-duck volumes (one per ducked session).
    snapshots: Vec<SessionVolumeSnapshot>,
}

impl SessionDuckState {
    /// Request a duck for `reason`. Returns `Duck` ONLY when transitioning from
    /// idle — the first reason captures the snapshots and lowers the sessions;
    /// later reasons piggyback on that duck (first level wins until everyone
    /// releases). Mirrors muteSystemAudio's `if (desiredMuted) return false`.
    fn request_duck(&mut self, reason: DuckReason) -> SessionDuckAction {
        let bit = reason.bit();
        if self.active_reasons & bit != 0 {
            return SessionDuckAction::NoOp;
        }
        let was_idle = self.active_reasons == 0;
        self.active_reasons |= bit;
        if was_idle {
            self.ducked = false;
            self.snapshots.clear();
            SessionDuckAction::Duck
        } else {
            SessionDuckAction::NoOp
        }
    }

    /// Record the snapshots the COM duck captured. Returns snapshots to restore
    /// IMMEDIATELY when every reason was released while the duck was in flight
    /// (the unmute-racing-pending-duck case); empty otherwise. Mirrors applyDuck
    /// flipping isDucked=true, plus the audio-mute.ts race latch.
    fn on_duck_complete(
        &mut self,
        snapshots: Vec<SessionVolumeSnapshot>,
    ) -> Vec<SessionVolumeSnapshot> {
        self.snapshots = snapshots;
        self.ducked = true;
        if self.active_reasons == 0 {
            self.ducked = false;
            std::mem::take(&mut self.snapshots)
        } else {
            Vec::new()
        }
    }

    /// Request a restore for `reason`. Returns the snapshots to restore when the
    /// LAST reason releases AND the duck COM had completed; empty otherwise (a
    /// still-active reason keeps the duck, or a duck still in flight whose worker
    /// will restore once it sees `active_reasons == 0`). Mirrors
    /// unmuteSystemAudio's `if (!desiredMuted) return` + applyRestore's
    /// `if (!isDucked) return`.
    fn request_restore(&mut self, reason: DuckReason) -> Vec<SessionVolumeSnapshot> {
        let bit = reason.bit();
        if self.active_reasons & bit == 0 {
            return Vec::new();
        }
        self.active_reasons &= !bit;
        if self.active_reasons != 0 {
            return Vec::new();
        }
        if self.ducked {
            self.ducked = false;
            std::mem::take(&mut self.snapshots)
        } else {
            Vec::new()
        }
    }
}

static SESSION_DUCK_STATE: OnceLock<Mutex<SessionDuckState>> = OnceLock::new();

fn session_state() -> &'static Mutex<SessionDuckState> {
    SESSION_DUCK_STATE.get_or_init(|| Mutex::new(SessionDuckState::default()))
}

fn lock_session_state() -> std::sync::MutexGuard<'static, SessionDuckState> {
    match session_state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::warn!("[ducking] session state lock poisoned; recovering");
            poisoned.into_inner()
        }
    }
}

// ───────────────────────── public duck/restore API ─────────────────────────

fn settings_duck_reduction_pct(app: &tauri::AppHandle) -> u8 {
    crate::winstt::commands::settings::read_settings_raw(app)
        .general
        .system_audio_reduction_while_dictating
        .clamp(0, 100) as u8
}

/// Apply `general.systemAudioReductionWhileDictating`, BLOCKING until the
/// background sessions are actually lowered. The recording-chime path calls this
/// FIRST so background audio is ducked before the chime plays — the chime is in
/// WinSTT's own (protected) process, so it stays at full volume.
pub fn duck_from_settings_blocking(app: &tauri::AppHandle) {
    let pct = settings_duck_reduction_pct(app);
    if pct == 0 {
        return;
    }
    duck_sessions_blocking(DuckReason::Dictation, pct);
}

/// Apply `general.systemAudioReductionWhileDictating` for Read Aloud playback.
pub fn duck_read_aloud_from_settings(app: &tauri::AppHandle) {
    let pct = settings_duck_reduction_pct(app);
    if pct == 0 {
        return;
    }
    request_session_duck_async(DuckReason::ReadAloud, pct);
}

/// Restore the background sessions ducked for dictation (PTT release / terminal
/// event). No-op unless dictation was the last reason holding the duck.
pub fn request_restore() {
    request_session_restore(DuckReason::Dictation);
}

/// Restore the background sessions ducked for Read Aloud (playback ended /
/// cancelled). No-op unless Read Aloud was the last reason holding the duck.
pub fn request_read_aloud_restore() {
    request_session_restore(DuckReason::ReadAloud);
}

fn duck_sessions_blocking(reason: DuckReason, reduction_pct: u8) {
    if lock_session_state().request_duck(reason) != SessionDuckAction::Duck {
        return;
    }
    let snapshots = perform_session_duck(reduction_pct).unwrap_or_default();
    let restore_now = lock_session_state().on_duck_complete(snapshots);
    if !restore_now.is_empty() {
        perform_session_restore(restore_now);
    }
}

fn request_session_duck_async(reason: DuckReason, reduction_pct: u8) {
    if lock_session_state().request_duck(reason) != SessionDuckAction::Duck {
        return;
    }
    std::thread::spawn(move || {
        let snapshots = perform_session_duck(reduction_pct).unwrap_or_default();
        let restore_now = lock_session_state().on_duck_complete(snapshots);
        if !restore_now.is_empty() {
            perform_session_restore(restore_now);
        }
    });
}

fn request_session_restore(reason: DuckReason) {
    let snapshots = lock_session_state().request_restore(reason);
    if !snapshots.is_empty() {
        std::thread::spawn(move || perform_session_restore(snapshots));
    }
}

// ── ISimpleAudioVolume per-session COM impl ─────────────────────────────────
//
// Enumerates the default render endpoint's audio sessions and lowers each one
// that does NOT belong to WinSTT or its child processes. Returns None on any COM
// failure (the caller treats that as "nothing ducked").

#[cfg(windows)]
struct AudioSessionVolume {
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

#[cfg(windows)]
fn enumerate_audio_session_volumes() -> Option<Vec<AudioSessionVolume>> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eMultimedia, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        ISimpleAudioVolume, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    let _com = crate::windows_com::ComApartment::init_multithreaded();
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
            let Ok(volume) = session.cast::<ISimpleAudioVolume>() else {
                continue;
            };
            volumes.push(AudioSessionVolume { pid, volume });
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
        let Ok(current) = (unsafe { session.volume.GetMasterVolume() }) else {
            continue;
        };
        let target = reduction_target(current, reduction_pct);
        if unsafe {
            session
                .volume
                .SetMasterVolume(target, std::ptr::null())
                .is_ok()
        } {
            snapshots.push(SessionVolumeSnapshot {
                pid: session.pid,
                volume: current,
            });
        }
    }

    Some(snapshots)
}

#[cfg(windows)]
fn perform_session_restore(snapshots: Vec<SessionVolumeSnapshot>) {
    let Some(sessions) = enumerate_audio_session_volumes() else {
        return;
    };

    for session in sessions {
        let Some(snapshot) = snapshots.iter().find(|s| s.pid == session.pid) else {
            continue;
        };
        let _ = unsafe {
            session
                .volume
                .SetMasterVolume(snapshot.volume, std::ptr::null())
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
fn perform_session_restore(_snapshots: Vec<SessionVolumeSnapshot>) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(pid: u32, volume: f32) -> SessionVolumeSnapshot {
        SessionVolumeSnapshot { pid, volume }
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

    // ── reason-counted session-duck state machine ──

    #[test]
    fn duck_then_restore_full_cycle() {
        let mut s = SessionDuckState::default();
        assert_eq!(
            s.request_duck(DuckReason::Dictation),
            SessionDuckAction::Duck
        );
        // COM captured two background sessions; nobody released, so nothing to
        // restore yet.
        assert!(s
            .on_duck_complete(vec![snap(10, 0.8), snap(20, 0.5)])
            .is_empty());

        // releasing the only reason returns the captured snapshots to restore.
        let restore = s.request_restore(DuckReason::Dictation);
        assert_eq!(restore, vec![snap(10, 0.8), snap(20, 0.5)]);
        // a second restore is a no-op (nothing left ducked).
        assert!(s.request_restore(DuckReason::Dictation).is_empty());
    }

    #[test]
    fn second_reason_piggybacks_first_duck() {
        let mut s = SessionDuckState::default();
        assert_eq!(
            s.request_duck(DuckReason::Dictation),
            SessionDuckAction::Duck
        );
        // a second reason while already ducked does NOT re-enumerate.
        assert_eq!(
            s.request_duck(DuckReason::ReadAloud),
            SessionDuckAction::NoOp
        );
        // duplicate request for an already-active reason is also a no-op.
        assert_eq!(
            s.request_duck(DuckReason::Dictation),
            SessionDuckAction::NoOp
        );
    }

    #[test]
    fn restore_waits_for_all_reasons() {
        let mut s = SessionDuckState::default();
        s.request_duck(DuckReason::Dictation);
        s.request_duck(DuckReason::ReadAloud);
        s.on_duck_complete(vec![snap(7, 0.9)]);

        // dictation releasing first keeps the duck (Read Aloud still wants it).
        assert!(s.request_restore(DuckReason::Dictation).is_empty());
        // Read Aloud releasing last restores.
        assert_eq!(s.request_restore(DuckReason::ReadAloud), vec![snap(7, 0.9)]);
    }

    #[test]
    fn restore_racing_pending_duck_restores_when_com_completes() {
        // Models a super-fast PTT tap: the restore arrives before the duck COM
        // reported its captured snapshots.
        let mut s = SessionDuckState::default();
        assert_eq!(
            s.request_duck(DuckReason::Dictation),
            SessionDuckAction::Duck
        );
        // unmute arrives before on_duck_complete → nothing to restore yet (the
        // duck worker still owns the snapshots).
        assert!(s.request_restore(DuckReason::Dictation).is_empty());
        // duck completes afterwards; since no reason is active, the worker is
        // told to restore immediately.
        let restore = s.on_duck_complete(vec![snap(3, 0.4)]);
        assert_eq!(restore, vec![snap(3, 0.4)]);
        assert!(!s.ducked);
    }

    #[test]
    fn restore_without_duck_is_noop() {
        let mut s = SessionDuckState::default();
        assert!(s.request_restore(DuckReason::Dictation).is_empty());
    }

    #[test]
    fn empty_snapshot_capture_still_clears_state() {
        // COM duck found no background sessions (or failed): no snapshots, and a
        // later restore is a clean no-op rather than a leak.
        let mut s = SessionDuckState::default();
        s.request_duck(DuckReason::Dictation);
        assert!(s.on_duck_complete(Vec::new()).is_empty());
        assert!(s.ducked);
        assert!(s.request_restore(DuckReason::Dictation).is_empty());
        assert!(!s.ducked);
    }
}

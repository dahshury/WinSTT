// Source: frontend/electron/ipc/audio-mute.ts
// + app/src-tauri/src/managers/audio.rs (set_mute COM pattern)
//
// Graduated system-audio ducking while dictating. WinSTT-the reference does this
// with a PowerShell COM host; the Rust/Tauri port does it in-process via the
// `windows` crate's IAudioEndpointVolume — the SAME interface Handy already
// uses for set_mute (managers/audio.rs), so no new Cargo features are needed
// beyond what's already enabled (Win32_Media_Audio_Endpoints + Com +
// StructuredStorage + Variant + Foundation).
//
// Difference from Handy's set_mute: Handy hard-MUTES via SetMute(true). WinSTT
// DUCKS — reads the current master scalar (0.0–1.0), drops it to
// `previous × (100 - reductionPct) / 100`, and restores the saved value on
// stop. reductionPct=100 ⇒ full mute (→0.0); smaller values merely attenuate.
// Reasons (verbatim from audio-mute.ts): the mute toggle shows the Windows OSD
// pill (distracting on every PTT), and a crash mid-dictation would leave the
// user muted; a duck degrades gracefully (audio still plays, faintly).
//
// Ported faithfully:
//   - reductionTarget(volume, pct) math + clamp [0,1].
//   - parseVolume scalar parsing tolerance.
//   - two-layer state (desired intent vs ducked effect) so an unmute that
//     races an in-flight duck still restores. [desiredMuted / isDucked / savedVolume]
//   - restore target fallback (savedVolume ?? 0.5).
//
// The reduction/clamp/state math is PURE and fully tested. The COM read/set is
// a real Windows impl modeled on Handy's set_mute (the only unverifiable bit is
// runtime COM behavior, which the compile loop confirms).

// ───────────────────────── pure reduction math ────────────────────────

/// Clamp a scalar to [0, 1]. NaN → 0. Mirrors clampScalar.
use std::sync::{Mutex, OnceLock};

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

/// Default restore target when no saved volume exists. Mirrors
/// computeRestoreTarget (savedVolume ?? 0.5).
pub const RESTORE_FALLBACK: f32 = 0.5;

pub fn restore_target(saved_volume: Option<f32>) -> f32 {
    saved_volume.unwrap_or(RESTORE_FALLBACK)
}

// ───────────────────── two-layer duck/restore state ───────────────────
//
// Mirrors the desiredMuted / isDucked / savedVolume latches in audio-mute.ts.
// `desired_muted` = what the caller most recently asked for (intent).
// `ducked` = whether we actually issued the duck and captured the previous
// volume (effect). They diverge while a COM call is "in flight" — the manager
// serializes the actual COM work on a worker, but the intent gate here ensures
// an unmute that races a pending duck always schedules a restore.

/// One step the manager should perform to reach the requested state. The state
/// machine returns these; the manager executes them (COM read/set) on its
/// serialized worker, then reports the outcome back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuckAction {
    /// Read current volume, save it, set it to the reduction target.
    Duck { reduction_pct: u8 },
    /// Restore the saved volume (or the fallback).
    Restore,
    /// Nothing to do (idempotent request).
    NoOp,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct DuckState {
    /// Intent: caller asked to duck (true) or restore (false).
    desired_muted: bool,
    /// Effect: we have issued the duck and captured the previous volume.
    ducked: bool,
    /// The pct captured for the active/pending duck.
    pending_reduction_pct: u8,
    /// The playback volume captured before the active duck.
    saved_volume: Option<f32>,
}

impl DuckState {
    pub fn new() -> Self {
        Self {
            desired_muted: false,
            ducked: false,
            pending_reduction_pct: 100,
            saved_volume: None,
        }
    }

    /// Request a duck at `reduction_pct` (default 100 = full mute). Returns the
    /// action to perform. A second duck while already intending to duck is a
    /// no-op (first level wins until the matching unmute). Mirrors
    /// muteSystemAudio's `if (desiredMuted) return false`.
    pub fn request_duck(&mut self, reduction_pct: u8) -> DuckAction {
        if self.desired_muted {
            return DuckAction::NoOp;
        }
        self.desired_muted = true;
        self.pending_reduction_pct = reduction_pct.min(100);
        DuckAction::Duck {
            reduction_pct: self.pending_reduction_pct,
        }
    }

    /// Request a restore. No-op if we never intended to duck. Mirrors
    /// unmuteSystemAudio's `if (!desiredMuted) return`.
    pub fn request_restore(&mut self) -> DuckAction {
        if !self.desired_muted {
            return DuckAction::NoOp;
        }
        self.desired_muted = false;
        DuckAction::Restore
    }

    /// Report that the duck COM work completed (the previous volume was
    /// captured). Mirrors applyDuck flipping isDucked=true on success.
    /// `saved` is None when the read/set failed — in which case the effect
    /// stays un-ducked so a later restore is correctly skipped (mirrors the
    /// guard in applyRestore: `if (!isDucked) return`).
    pub fn on_duck_complete(&mut self, saved: Option<f32>) {
        self.ducked = saved.is_some();
        self.saved_volume = saved;
    }

    /// Report that the restore COM work completed. Mirrors applyRestore
    /// clearing isDucked + savedVolume even when SetVolume failed (so we don't
    /// loop forever).
    pub fn on_restore_complete(&mut self) {
        self.ducked = false;
        self.saved_volume = None;
    }

    /// Whether a restore should actually touch the volume (we previously
    /// captured a duck). Mirrors applyRestore's `if (!isDucked) return`.
    pub fn should_restore(&self) -> bool {
        self.ducked
    }

    pub fn desired_muted(&self) -> bool {
        self.desired_muted
    }

    pub fn pending_reduction_pct(&self) -> u8 {
        self.pending_reduction_pct
    }

    pub fn saved_volume(&self) -> Option<f32> {
        self.saved_volume
    }
}

// ── IAudioEndpointVolume COM impl (real — modeled on Handy set_mute) ───
//
// Reads / sets the default render endpoint's master scalar. Returns None on
// any COM failure (mirrors the unwrap_or_return! pattern in set_mute). The
// caller (manager worker) feeds these into the DuckState callbacks above.

/// Read the default playback device's master volume scalar (0.0–1.0).
/// Mirrors readCurrentVolume / [Audio]::GetVolume().
static DUCK_STATE: OnceLock<Mutex<DuckState>> = OnceLock::new();

fn state() -> &'static Mutex<DuckState> {
    DUCK_STATE.get_or_init(|| Mutex::new(DuckState::new()))
}

fn lock_state() -> std::sync::MutexGuard<'static, DuckState> {
    match state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::warn!("[ducking] state lock poisoned; recovering");
            poisoned.into_inner()
        }
    }
}

fn spawn_restore_if_needed() {
    std::thread::spawn(|| {
        let saved = {
            let guard = lock_state();
            if !guard.should_restore() {
                return;
            }
            guard.saved_volume()
        };

        let _ = perform_restore(saved);
        lock_state().on_restore_complete();
    });
}

/// Apply `general.systemAudioReductionWhileDictating` for a recording start.
pub fn duck_from_settings(app: &tauri::AppHandle) {
    let pct = crate::winstt::commands::settings::read_settings_raw(app)
        .general
        .system_audio_reduction_while_dictating
        .clamp(0, 100) as u8;
    if pct == 0 {
        return;
    }
    request_duck(pct);
}

pub fn request_duck(reduction_pct: u8) {
    let action = lock_state().request_duck(reduction_pct);
    if let DuckAction::Duck { reduction_pct } = action {
        std::thread::spawn(move || {
            let saved = perform_duck(reduction_pct);
            let should_restore = {
                let mut guard = lock_state();
                guard.on_duck_complete(saved);
                !guard.desired_muted() && guard.should_restore()
            };
            if should_restore {
                spawn_restore_if_needed();
            }
        });
    }
}

pub fn request_restore() {
    if lock_state().request_restore() == DuckAction::Restore {
        spawn_restore_if_needed();
    }
}

#[cfg(windows)]
pub fn read_master_volume() -> Option<f32> {
    use windows::Win32::Media::Audio::{
        eMultimedia, eRender, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator,
        MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    let _com = crate::windows_com::ComApartment::init_multithreaded();
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .ok()?;
        let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).ok()?;
        let scalar = volume.GetMasterVolumeLevelScalar().ok()?;
        Some(clamp_scalar(scalar))
    }
}

/// Set the default playback device's master volume scalar (0.0–1.0). Returns
/// false on any COM failure. Mirrors [Audio]::SetVolume(target).
#[cfg(windows)]
pub fn set_master_volume(scalar: f32) -> bool {
    use windows::Win32::Media::Audio::{
        eMultimedia, eRender, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator,
        MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    let target = clamp_scalar(scalar);
    let _com = crate::windows_com::ComApartment::init_multithreaded();
    unsafe {
        let Ok(enumerator) =
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        else {
            return false;
        };
        let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) else {
            return false;
        };
        let Ok(volume) = device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) else {
            return false;
        };
        // pguideventcontext = null (no event-context GUID).
        volume
            .SetMasterVolumeLevelScalar(target, std::ptr::null())
            .is_ok()
    }
}

/// Perform a duck: read → save → set to the reduction target. Returns the
/// saved (previous) volume on success, None on failure. Mirrors performDuck.
/// The manager hands the result to `DuckState::on_duck_complete`.
#[cfg(windows)]
pub fn perform_duck(reduction_pct: u8) -> Option<f32> {
    let current = read_master_volume()?;
    let target = reduction_target(current, reduction_pct);
    if set_master_volume(target) {
        Some(current)
    } else {
        None
    }
}

/// Perform a restore to `saved` (or the fallback). Mirrors applyRestore.
#[cfg(windows)]
pub fn perform_restore(saved: Option<f32>) -> bool {
    set_master_volume(restore_target(saved))
}

// Non-Windows stubs so the manager wiring compiles cross-platform. WinSTT is
// Windows-first; ducking is a no-op elsewhere (mirrors muteSystemAudio's
// `if (process.platform !== "win32") return false`).
#[cfg(not(windows))]
pub fn read_master_volume() -> Option<f32> {
    None
}

#[cfg(not(windows))]
pub fn set_master_volume(_scalar: f32) -> bool {
    false
}

#[cfg(not(windows))]
pub fn perform_duck(_reduction_pct: u8) -> Option<f32> {
    None
}

#[cfg(not(windows))]
pub fn perform_restore(_saved: Option<f32>) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn restore_target_uses_fallback_when_unsaved() {
        assert_eq!(restore_target(None), 0.5);
        assert_eq!(restore_target(Some(0.3)), 0.3);
    }

    // ── two-layer state machine ──

    #[test]
    fn duck_then_restore_full_cycle() {
        let mut s = DuckState::new();
        assert_eq!(s.request_duck(100), DuckAction::Duck { reduction_pct: 100 });
        s.on_duck_complete(Some(0.8)); // captured previous volume
        assert!(s.should_restore());

        assert_eq!(s.request_restore(), DuckAction::Restore);
        s.on_restore_complete();
        assert!(!s.should_restore());
        assert!(!s.desired_muted());
    }

    #[test]
    fn second_duck_is_noop_first_level_wins() {
        let mut s = DuckState::new();
        assert_eq!(s.request_duck(80), DuckAction::Duck { reduction_pct: 80 });
        // a second duck (even at a different pct) is ignored until unmute
        assert_eq!(s.request_duck(100), DuckAction::NoOp);
        assert_eq!(s.pending_reduction_pct(), 80);
    }

    #[test]
    fn restore_without_duck_is_noop() {
        let mut s = DuckState::new();
        assert_eq!(s.request_restore(), DuckAction::NoOp);
    }

    #[test]
    fn failed_duck_skips_restore_effect() {
        let mut s = DuckState::new();
        s.request_duck(100);
        s.on_duck_complete(None); // COM duck failed — no previous captured
                                  // intent restore still flips desired, but effect says don't touch volume
        assert!(!s.should_restore());
        assert_eq!(s.request_restore(), DuckAction::Restore);
        assert!(!s.should_restore());
    }

    #[test]
    fn unmute_racing_pending_duck_still_schedules_restore() {
        // Models the audio-mute.ts race: user releases PTT (request_restore)
        // before the in-flight duck reported completion. The intent latch
        // (desired_muted) ensures the restore is still scheduled; when the duck
        // later completes the manager re-evaluates.
        let mut s = DuckState::new();
        s.request_duck(100); // desired=true
                             // unmute arrives before on_duck_complete
        assert_eq!(s.request_restore(), DuckAction::Restore); // desired=false
                                                              // duck completes afterwards, captured volume
        s.on_duck_complete(Some(0.8));
        // effect is ducked; the manager, seeing desired=false, must restore.
        assert!(s.should_restore());
        assert!(!s.desired_muted());
    }
}

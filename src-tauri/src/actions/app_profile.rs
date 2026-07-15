use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::winstt::app_profiles::{AppIdentity, resolve_rule};
use crate::winstt::context::ContextMode;
#[cfg(not(windows))]
use crate::winstt::context::snapshot::ContextReader;
use crate::winstt::managers::ContextManager;
use crate::winstt::settings_schema::{AppProfileConfig, AppProfileRule, RecordingMode};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct ResolvedAppProfile {
    pub(super) rule_id: String,
    pub(super) configuration_id: String,
    pub(super) configuration_name: String,
    pub(super) app_exe: String,
    pub(super) config: AppProfileConfig,
}

#[derive(Clone, Debug, PartialEq)]
enum SlotState {
    Idle,
    Pending,
    Ready(Option<ResolvedAppProfile>),
}

#[derive(Debug)]
struct ActiveSlot {
    generation: u64,
    state: SlotState,
}

static ACTIVE: Lazy<(Mutex<ActiveSlot>, Condvar)> = Lazy::new(|| {
    (
        Mutex::new(ActiveSlot {
            generation: 0,
            state: SlotState::Idle,
        }),
        Condvar::new(),
    )
});

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveProfileEvent {
    rule_id: String,
    configuration_id: String,
    configuration_name: String,
    app_exe: String,
}

fn resolved(rule: &AppProfileRule, identity: &AppIdentity) -> ResolvedAppProfile {
    ResolvedAppProfile {
        rule_id: rule.id.clone(),
        configuration_id: rule.configuration_id.clone(),
        configuration_name: rule.configuration_name.clone(),
        app_exe: identity.app_exe.clone(),
        config: rule.config.clone(),
    }
}

fn resolve(
    rules: &[AppProfileRule],
    identity: &AppIdentity,
    openrouter_key_present: bool,
) -> Option<ResolvedAppProfile> {
    resolve_rule(rules, identity, openrouter_key_present).map(|rule| resolved(rule, identity))
}

fn begin_resolution(state: SlotState) -> u64 {
    let mut slot = ACTIVE
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    slot.generation = slot.generation.wrapping_add(1);
    slot.state = state;
    ACTIVE.1.notify_all();
    slot.generation
}

fn commit_resolution(generation: u64, profile: Option<ResolvedAppProfile>) -> bool {
    {
        let mut slot = ACTIVE
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if slot.generation != generation {
            return false;
        }
        slot.state = SlotState::Ready(profile.clone());
    }
    ACTIVE.1.notify_all();
    true
}

fn set_ready(app: &AppHandle, generation: u64, profile: Option<ResolvedAppProfile>) {
    if !commit_resolution(generation, profile.clone()) {
        return;
    }
    if let Some(profile) = profile {
        let payload = ActiveProfileEvent {
            rule_id: profile.rule_id,
            configuration_id: profile.configuration_id,
            configuration_name: profile.configuration_name,
            app_exe: profile.app_exe,
        };
        let _ = app.emit(
            crate::winstt::commands::events::names::LLM_APP_PROFILE_ACTIVE,
            payload,
        );
    }
}

/// Resolve the active rule against the window pinned at recording start. The
/// common exe/title-only Windows path is synchronous and cheap; URL capture is
/// performed on a background thread so recording startup is never delayed.
pub(super) fn resolve_at_start(app: &AppHandle, pinned_hwnd: Option<u64>) {
    let settings = crate::winstt::commands::settings::read_settings(app);
    let rules = settings.llm.app_profiles.rules;
    if !settings.llm.dictation.enabled
        || settings.general.recording_mode == RecordingMode::Listen
        || rules.is_empty()
    {
        begin_resolution(SlotState::Ready(None));
        return;
    }

    let openrouter_key_present = !settings.llm.openrouter_api_key.trim().is_empty();

    #[cfg(windows)]
    {
        let Some(hwnd) = pinned_hwnd else {
            begin_resolution(SlotState::Ready(None));
            return;
        };
        let identity = identity_for_hwnd(hwnd);
        let needs_url = rules
            .iter()
            .any(|rule| rule.enabled && !rule.url_pattern.trim().is_empty());
        if !needs_url {
            let generation = begin_resolution(SlotState::Pending);
            set_ready(
                app,
                generation,
                resolve(&rules, &identity, openrouter_key_present),
            );
            return;
        }

        let Some(manager) = app.try_state::<std::sync::Arc<ContextManager>>() else {
            // URL rules cannot match without the sidecar, but exe/title rules
            // still can and remain eligible as fallbacks.
            let generation = begin_resolution(SlotState::Pending);
            set_ready(
                app,
                generation,
                resolve(&rules, &identity, openrouter_key_present),
            );
            return;
        };
        let manager = std::sync::Arc::clone(manager.inner());
        let app = app.clone();
        let generation = begin_resolution(SlotState::Pending);
        std::thread::spawn(move || {
            let snapshot = manager.read_hwnd(ContextMode::Meta, hwnd);
            let mut identity = identity;
            identity.url = snapshot.url.unwrap_or_default();
            set_ready(
                &app,
                generation,
                resolve(&rules, &identity, openrouter_key_present),
            );
        });
    }

    #[cfg(not(windows))]
    {
        let _ = pinned_hwnd;
        let Some(manager) = app.try_state::<std::sync::Arc<ContextManager>>() else {
            begin_resolution(SlotState::Ready(None));
            return;
        };
        let manager = std::sync::Arc::clone(manager.inner());
        let app = app.clone();
        let generation = begin_resolution(SlotState::Pending);
        std::thread::spawn(move || {
            let snapshot = manager.read(ContextMode::Meta);
            let identity = AppIdentity {
                app_exe: snapshot.app_exe.unwrap_or_default(),
                window_title: snapshot.window_title,
                url: snapshot.url.unwrap_or_default(),
            };
            set_ready(
                &app,
                generation,
                resolve(&rules, &identity, openrouter_key_present),
            );
        });
    }
}

/// Read the current resolution without consuming it. Pending URL capture waits
/// up to `timeout`; timeout and Idle both fail soft to the default config.
pub(super) fn take_resolved(timeout: Duration) -> Option<ResolvedAppProfile> {
    let deadline = Instant::now() + timeout;
    let mut slot = ACTIVE
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    loop {
        match &slot.state {
            SlotState::Ready(profile) => return profile.clone(),
            SlotState::Idle => return None,
            SlotState::Pending => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return None;
                }
                let (next, wait) = ACTIVE
                    .1
                    .wait_timeout(slot, remaining)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                slot = next;
                if wait.timed_out() && matches!(slot.state, SlotState::Pending) {
                    return None;
                }
            }
        }
    }
}

pub(super) fn clear() {
    let mut slot = ACTIVE
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    slot.generation = slot.generation.wrapping_add(1);
    slot.state = SlotState::Idle;
    ACTIVE.1.notify_all();
}

#[cfg(windows)]
fn identity_for_hwnd(hwnd: u64) -> AppIdentity {
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextW, GetWindowThreadProcessId};

    let hwnd = HWND(hwnd as usize as *mut core::ffi::c_void);
    if hwnd.is_invalid() {
        return AppIdentity::default();
    }
    let mut title_buf = [0u16; 512];
    let title_len = unsafe { GetWindowTextW(hwnd, &mut title_buf) };
    let window_title = if title_len > 0 {
        String::from_utf16_lossy(&title_buf[..title_len as usize])
    } else {
        String::new()
    };

    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return AppIdentity {
            window_title,
            ..Default::default()
        };
    }
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return AppIdentity {
            window_title,
            ..Default::default()
        };
    };
    let mut path_buf = [0u16; 260];
    let mut path_len = path_buf.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(path_buf.as_mut_ptr()),
            &mut path_len,
        )
    };
    let _ = unsafe { CloseHandle(handle) };
    let app_exe = if result.is_ok() && path_len > 0 {
        let path = String::from_utf16_lossy(&path_buf[..path_len as usize]);
        path.rsplit(['\\', '/'])
            .next()
            .unwrap_or(&path)
            .to_lowercase()
    } else {
        String::new()
    };
    AppIdentity {
        app_exe,
        window_title,
        url: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn idle_and_ready_slots_are_non_destructive() {
        let _guard = TEST_LOCK.lock().unwrap();
        clear();
        assert_eq!(take_resolved(Duration::ZERO), None);
        let profile = ResolvedAppProfile {
            rule_id: "rule".into(),
            configuration_id: "config".into(),
            configuration_name: "Formal".into(),
            app_exe: "chrome.exe".into(),
            config: AppProfileConfig::default(),
        };
        let generation = begin_resolution(SlotState::Pending);
        ACTIVE.0.lock().unwrap().state = SlotState::Ready(Some(profile.clone()));
        assert_eq!(take_resolved(Duration::ZERO), Some(profile.clone()));
        assert_eq!(take_resolved(Duration::ZERO), Some(profile));
        assert_eq!(ACTIVE.0.lock().unwrap().generation, generation);
        clear();
    }

    #[test]
    fn pending_slot_times_out() {
        let _guard = TEST_LOCK.lock().unwrap();
        begin_resolution(SlotState::Pending);
        let started = Instant::now();
        assert_eq!(take_resolved(Duration::from_millis(10)), None);
        assert!(started.elapsed() >= Duration::from_millis(8));
        clear();
    }

    #[test]
    fn a_late_resolution_cannot_overwrite_a_newer_session() {
        let _guard = TEST_LOCK.lock().unwrap();
        clear();
        let stale_generation = begin_resolution(SlotState::Pending);
        let current_generation = begin_resolution(SlotState::Ready(None));
        assert_ne!(stale_generation, current_generation);
        let stale_profile = ResolvedAppProfile {
            rule_id: "stale".into(),
            configuration_id: "stale".into(),
            configuration_name: "Stale".into(),
            app_exe: "stale.exe".into(),
            config: AppProfileConfig::default(),
        };
        assert!(!commit_resolution(stale_generation, Some(stale_profile)));
        let slot = ACTIVE.0.lock().unwrap();
        assert_eq!(slot.generation, current_generation);
        assert_eq!(slot.state, SlotState::Ready(None));
    }
}

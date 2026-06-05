// PORT IMPL — shared in-flight cancel registry.
//
// Several managers (cloud STT, LLM, TTS) track which request ids have been
// cancelled so their async drain loops can bail between chunks. The original
// per-manager copies used `Mutex<HashMap<String, bool>>` where the bool was
// always `true` (so the value carried no information).
//
// `CancelRegistry` collapses that to a `Mutex<HashSet<String>>`: presence ==
// cancelled. Memory is reclaimed by `clear`, which the drain loops call when a
// request finishes (cancelled or not), so cancelled ids do not accumulate
// across sessions. `cancel_all` marks every currently-tracked request cancelled
// without dropping the marks (an in-flight loop must still observe its id as
// cancelled), faithful to the previous flip-all-to-true behavior. The lock is
// never held across an `.await`.

use std::collections::HashSet;
use std::sync::Mutex;

/// Thread-safe set of cancelled request ids. Cheap to construct; share by
/// embedding directly in a manager struct (no `Arc` needed — managers live in
/// Tauri state behind a shared reference).
#[derive(Default)]
pub struct CancelRegistry {
    state: Mutex<CancelState>,
}

#[derive(Default)]
struct CancelState {
    active: HashSet<String>,
    cancelled: HashSet<String>,
}

impl CancelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a request as in-flight. This intentionally does not clear an
    /// existing cancellation mark: callers may cancel by id just before the
    /// worker starts observing that id.
    pub fn track(&self, request_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.active.insert(request_id.to_string());
        }
    }

    /// Mark a single request cancelled.
    pub fn cancel(&self, request_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.cancelled.insert(request_id.to_string());
        }
    }

    /// Cancel every currently active request. Finished requests are reclaimed by
    /// `clear`, so cancelled ids do not accumulate across sessions.
    pub fn cancel_all(&self) {
        if let Ok(mut state) = self.state.lock() {
            let active: Vec<String> = state.active.iter().cloned().collect();
            state.cancelled.extend(active);
        }
    }

    /// Whether `request_id` has been cancelled. `default_when_poisoned` is the
    /// value returned if the lock is poisoned (TTS treats that as cancelled to
    /// fail safe; the others treat it as not-cancelled).
    pub fn is_cancelled(&self, request_id: &str, default_when_poisoned: bool) -> bool {
        self.state
            .lock()
            .map(|state| state.cancelled.contains(request_id))
            .unwrap_or(default_when_poisoned)
    }

    /// Stop tracking `request_id` (call when the request finishes).
    pub fn clear(&self, request_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.active.remove(request_id);
            state.cancelled.remove(request_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_then_observed() {
        let reg = CancelRegistry::new();
        assert!(!reg.is_cancelled("a", false));
        reg.cancel("a");
        assert!(reg.is_cancelled("a", false));
        reg.clear("a");
        assert!(!reg.is_cancelled("a", false));
    }

    #[test]
    fn cancel_all_keeps_marked_requests_cancelled() {
        let reg = CancelRegistry::new();
        reg.track("a");
        reg.track("b");
        reg.cancel_all();
        // A tracked id stays cancelled so an in-flight drain loop still bails.
        assert!(reg.is_cancelled("a", false));
        assert!(reg.is_cancelled("b", false));
        // Completed requests are reclaimed by clear (no leak).
        reg.clear("a");
        assert!(!reg.is_cancelled("a", false));
    }

    #[test]
    fn track_preserves_preexisting_cancel() {
        let reg = CancelRegistry::new();
        reg.cancel("a");
        reg.track("a");
        assert!(reg.is_cancelled("a", false));
    }
}

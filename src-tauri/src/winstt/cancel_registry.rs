// Shared in-flight cancel registry.
//
// Several managers (cloud STT, LLM, TTS) track which request ids have been
// cancelled. There are two consumption styles:
//   - POLL: a drain loop checks `is_cancelled(id)` between chunks (native Ollama).
//   - AWAIT: an async worker holds the `cancel_token(id)` and `tokio::select!`s on
//     `token.cancelled()`, dropping its in-flight reqwest/genai future to abort
//     the request the instant cancel fires (cloud LLM/STT/TTS mid-flight abort).
//
// Presence in `cancelled` == cancelled (poll path). `tokens` holds a latching
// `CancellationToken` per id (await path); `cancel`/`cancel_all` fire both so the
// two styles stay coherent. `clear` reclaims an id when its request finishes.
// `cancel_all` marks every currently-tracked id cancelled without dropping the
// marks (an in-flight loop must still observe its id as cancelled). The lock is
// never held across an `.await`.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;

/// Thread-safe registry of in-flight / cancelled request ids. Cheap to
/// construct; share by embedding directly in a manager struct.
#[derive(Default)]
pub struct CancelRegistry {
    state: Mutex<CancelState>,
}

#[derive(Default)]
struct CancelState {
    active: HashSet<String>,
    cancelled: HashSet<String>,
    /// Awaitable cancel handles, one per tracked id (for the select!-on-cancel path).
    tokens: HashMap<String, CancellationToken>,
}

impl CancelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a request as in-flight. This intentionally does not clear an
    /// existing cancellation mark: callers may cancel by id just before the
    /// worker starts observing that id (a pre-existing mark also pre-cancels the
    /// token).
    pub fn track(&self, request_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.active.insert(request_id.to_string());
            let pre_cancelled = state.cancelled.contains(request_id);
            let token = state
                .tokens
                .entry(request_id.to_string())
                .or_insert_with(CancellationToken::new);
            if pre_cancelled {
                token.cancel();
            }
        }
    }

    /// Register `request_id` as in-flight and return its awaitable
    /// [`CancellationToken`]. A later `cancel(id)` / `cancel_all()` cancels this
    /// token, so an async worker can `tokio::select!` on `token.cancelled()` and
    /// drop its in-flight future to abort the request (reqwest/genai abort on
    /// drop). Honors a pre-existing cancel mark (returns an already-cancelled
    /// token). A poisoned lock yields an already-cancelled token (fail safe).
    pub fn cancel_token(&self, request_id: &str) -> CancellationToken {
        match self.state.lock() {
            Ok(mut state) => {
                state.active.insert(request_id.to_string());
                let pre_cancelled = state.cancelled.contains(request_id);
                let token = state
                    .tokens
                    .entry(request_id.to_string())
                    .or_insert_with(CancellationToken::new)
                    .clone();
                if pre_cancelled {
                    token.cancel();
                }
                token
            }
            Err(_) => {
                let token = CancellationToken::new();
                token.cancel();
                token
            }
        }
    }

    /// Mark a single request cancelled (fires both the poll mark and the token).
    pub fn cancel(&self, request_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.cancelled.insert(request_id.to_string());
            if let Some(token) = state.tokens.get(request_id) {
                token.cancel();
            }
        }
    }

    /// Cancel every currently active request (poll marks + tokens). Finished
    /// requests are reclaimed by `clear`, so cancelled ids do not accumulate.
    pub fn cancel_all(&self) {
        if let Ok(mut state) = self.state.lock() {
            let active: Vec<String> = state.active.iter().cloned().collect();
            state.cancelled.extend(active);
            for token in state.tokens.values() {
                token.cancel();
            }
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

    /// Stop tracking `request_id` (call when the request finishes). Drops its
    /// token; any already-cloned token handle still observes the final state.
    pub fn clear(&self, request_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.active.remove(request_id);
            state.cancelled.remove(request_id);
            state.tokens.remove(request_id);
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

    #[test]
    fn cancel_token_fires_on_cancel() {
        let reg = CancelRegistry::new();
        let token = reg.cancel_token("a");
        assert!(!token.is_cancelled());
        reg.cancel("a");
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancel_token_fires_on_cancel_all() {
        let reg = CancelRegistry::new();
        let token = reg.cancel_token("a");
        reg.cancel_all();
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancel_token_honors_preexisting_cancel() {
        let reg = CancelRegistry::new();
        reg.cancel("a");
        let token = reg.cancel_token("a");
        assert!(token.is_cancelled());
    }
}

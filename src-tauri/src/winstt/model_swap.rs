use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

#[derive(Default)]
struct ModelSwapState {
    in_flight: HashMap<String, usize>,
    warm: HashMap<String, Instant>,
    /// When a model last FAILED to load (e.g. the Ollama runner crashing because
    /// it does not fit in VRAM). Used to back off re-warming a model that keeps
    /// crashing, so the periodic loop doesn't churn the GPU every tick.
    load_failed: HashMap<String, Instant>,
}

/// Shared model lifecycle coordinator for subsystems that load or warm heavyweight models.
///
/// It intentionally tracks opaque keys instead of model-specific structs so STT, TTS, and LLM
/// managers can use the same coalescing/warm-state rules while keeping their existing IPC shapes.
pub struct ModelSwapCoordinator {
    state: Mutex<ModelSwapState>,
    condvar: Condvar,
    /// Async twin of `condvar`: wakes `claim_when_idle` waiters when any claim
    /// releases, so async callers wait on the release event instead of polling.
    idle_notify: Notify,
}

impl Default for ModelSwapCoordinator {
    fn default() -> Self {
        Self {
            state: Mutex::new(ModelSwapState::default()),
            condvar: Condvar::new(),
            idle_notify: Notify::new(),
        }
    }
}

impl ModelSwapCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_warm(&self, key: &str) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.warm.contains_key(key))
    }

    pub fn is_warm_within(&self, key: &str, max_age: Duration) -> bool {
        self.state.lock().is_ok_and(|state| {
            state
                .warm
                .get(key)
                .is_some_and(|marked| marked.elapsed() <= max_age)
        })
    }

    pub fn mark_warm(&self, key: impl Into<String>) {
        if let Ok(mut state) = self.state.lock() {
            let key = key.into();
            state.load_failed.remove(&key);
            state.warm.insert(key, Instant::now());
        }
    }

    pub fn clear_warm(&self, key: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.warm.remove(key);
        }
    }

    /// Record that loading `key` just FAILED, so [`Self::is_load_failed_within`]
    /// can back off re-warming it. Also clears any stale warm marker (a model
    /// that crashed is not warm).
    pub fn mark_load_failed(&self, key: impl Into<String>) {
        if let Ok(mut state) = self.state.lock() {
            let key = key.into();
            state.warm.remove(&key);
            state.load_failed.insert(key, Instant::now());
        }
    }

    /// True iff `key`'s last load failure was within `backoff` — the caller
    /// should SKIP re-warming it (it would just crash/churn again). A successful
    /// load clears the marker via [`Self::mark_warm`].
    pub fn is_load_failed_within(&self, key: &str, backoff: Duration) -> bool {
        self.state.lock().is_ok_and(|state| {
            state
                .load_failed
                .get(key)
                .is_some_and(|failed| failed.elapsed() <= backoff)
        })
    }

    pub fn clear_all_warm(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.warm.clear();
        }
    }

    pub fn warm_keys(&self) -> Vec<String> {
        self.state
            .lock()
            .map(|state| state.warm.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn try_claim(&self, key: impl Into<String>) -> Option<ModelSwapClaim<'_>> {
        let key = key.into();
        let mut state = self.state.lock().ok()?;
        if state.in_flight.contains_key(&key) {
            return None;
        }
        state.in_flight.insert(key.clone(), 1);
        Some(ModelSwapClaim {
            coordinator: self,
            key,
        })
    }

    /// Async claim: take `key`'s single-flight claim, waiting for the current
    /// holder to release instead of polling on a timer (every claim drop fires
    /// `idle_notify`, so waiters wake the instant the holder finishes). Returns
    /// `None` if the claim is still held at `deadline`.
    pub async fn claim_when_idle(
        &self,
        key: impl Into<String>,
        deadline: tokio::time::Instant,
    ) -> Option<ModelSwapClaim<'_>> {
        let key = key.into();
        loop {
            // Register for release notifications BEFORE checking the claim so a
            // release landing between the check and the await cannot be missed.
            let mut released = Box::pin(self.idle_notify.notified());
            released.as_mut().enable();
            if let Some(claim) = self.try_claim(key.clone()) {
                return Some(claim);
            }
            tokio::select! {
                () = &mut released => {}
                () = tokio::time::sleep_until(deadline) => return None,
            }
        }
    }

    pub fn wait_for_idle(&self, key: &str) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        while state.in_flight.contains_key(key) {
            state = match self.condvar.wait(state) {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
    }

    fn release(&self, key: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.in_flight.remove(key);
            self.condvar.notify_all();
        }
        self.idle_notify.notify_waiters();
    }
}

pub struct ModelSwapClaim<'a> {
    coordinator: &'a ModelSwapCoordinator,
    key: String,
}

impl Drop for ModelSwapClaim<'_> {
    fn drop(&mut self) {
        self.coordinator.release(&self.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_is_single_flight_per_key() {
        let coordinator = ModelSwapCoordinator::new();
        let claim = coordinator.try_claim("stt:tiny");
        assert!(claim.is_some());
        assert!(coordinator.try_claim("stt:tiny").is_none());
        assert!(coordinator.try_claim("stt:large").is_some());
    }

    #[test]
    fn warm_marker_tracks_recentness() {
        let coordinator = ModelSwapCoordinator::new();
        coordinator.mark_warm("llm:qwen");
        assert!(coordinator.is_warm("llm:qwen"));
        assert!(coordinator.is_warm_within("llm:qwen", Duration::from_secs(30)));
        coordinator.clear_warm("llm:qwen");
        assert!(!coordinator.is_warm("llm:qwen"));
    }

    #[tokio::test]
    async fn claim_when_idle_wakes_on_release() {
        let coordinator = ModelSwapCoordinator::new();
        let held = coordinator.try_claim("k").unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        // The waiter must acquire the claim the moment the holder drops it —
        // well before the 5s deadline (no polling tick involved).
        let (waiter, ()) = tokio::join!(coordinator.claim_when_idle("k", deadline), async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            drop(held);
        });
        assert!(waiter.is_some(), "waiter acquires the claim on release");
    }

    #[tokio::test]
    async fn claim_when_idle_times_out_while_held() {
        let coordinator = ModelSwapCoordinator::new();
        let _held = coordinator.try_claim("k").unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(20);
        assert!(coordinator.claim_when_idle("k", deadline).await.is_none());
    }

    #[test]
    fn load_failure_backs_off_until_cleared_by_a_successful_warm() {
        let coordinator = ModelSwapCoordinator::new();
        // A crashing load is remembered → the periodic loop should back off.
        coordinator.mark_load_failed("llm:gemma");
        assert!(coordinator.is_load_failed_within("llm:gemma", Duration::from_secs(300)));
        // An expired backoff window no longer suppresses re-warming.
        assert!(!coordinator.is_load_failed_within("llm:gemma", Duration::from_secs(0)));
        // A successful warm clears the failure (and marks warm).
        coordinator.mark_warm("llm:gemma");
        assert!(!coordinator.is_load_failed_within("llm:gemma", Duration::from_secs(300)));
        assert!(coordinator.is_warm("llm:gemma"));
        // Conversely, a fresh failure clears any stale warm marker.
        coordinator.mark_load_failed("llm:gemma");
        assert!(!coordinator.is_warm("llm:gemma"));
    }
}

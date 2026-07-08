// Shared HTTP clients for the cloud pipelines (STT / TTS / verify probes /
// connectivity watch).
//
// One process-wide `reqwest::Client` means one connection pool + TLS session
// cache: ElevenLabs STT, ElevenLabs TTS, the voice/subscription catalogs, and
// OpenRouter STT/TTS all hit the same two hosts, so per-engine
// `reqwest::Client::new()` calls were paying a fresh pool + handshake for every
// engine rebuild. Timeouts stay PER-REQUEST (`.timeout(...)` at each call
// site) because ceilings differ (5s connectivity probe vs 90s transcribe
// upload); the shared client itself carries no global timeout.
//
// The Ollama loopback client (`managers::llm_manager`) intentionally does NOT
// use this: it is built with `no_proxy()` so a system proxy can never black-hole
// localhost. Bulk model downloads (`downloads.rs`, `download_manager`) keep
// their own tuned clients too.

use std::sync::OnceLock;

/// Process-wide pooled HTTP client for cloud API calls.
pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Pooled client that refuses redirects — for fetching untrusted URLs that were
/// validated against a trust boundary (e.g. ElevenLabs CDN voice previews),
/// where following a redirect would bypass the pre-flight host/IP validation.
pub fn no_redirect_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| format!("no-redirect HTTP client init failed: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_clients_are_singletons() {
        // Same pool handed out on every call (Client is an Arc internally, so
        // pointer-equality of the OnceLock reference is the contract).
        assert!(std::ptr::eq(http_client(), http_client()));
        let a = no_redirect_client().expect("no-redirect client builds");
        let b = no_redirect_client().expect("no-redirect client builds");
        assert!(std::ptr::eq(a, b));
    }
}

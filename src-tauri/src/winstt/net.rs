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

fn api_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::custom(|attempt| {
        attempt.error("API redirects are disabled; configure the final endpoint URL")
    }))
}

/// Process-wide pooled HTTP client for cloud API calls. A redirect must not replay
/// an audio/text upload at an endpoint the user did not select. Model downloads
/// use their own clients and keep following Hub/CDN redirects.
pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        api_client_builder()
            .build()
            .expect("cloud API HTTP client init")
    })
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

    #[tokio::test]
    async fn api_redirects_never_replay_private_uploads() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::Duration;

        for status in [307, 308] {
            let target = TcpListener::bind("127.0.0.1:0").unwrap();
            target.set_nonblocking(true).unwrap();
            let source = TcpListener::bind("127.0.0.1:0").unwrap();
            let source_url = format!("http://{}/upload", source.local_addr().unwrap());
            let target_url = format!("http://{}/other", target.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = source.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                while !request.ends_with(b"private transcript or audio") {
                    let count = socket.read(&mut buffer).unwrap();
                    assert!(count > 0 && request.len() + count <= 8192);
                    request.extend_from_slice(&buffer[..count]);
                }
                write!(socket, "HTTP/1.1 {status} Redirect\r\nLocation: {target_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            });
            let client = api_client_builder().no_proxy().build().unwrap();
            let error = client
                .post(source_url)
                .bearer_auth("test-only-key")
                .body("private transcript or audio")
                .timeout(Duration::from_secs(3))
                .send()
                .await
                .unwrap_err();
            server.join().unwrap();
            assert!(error.is_redirect(), "{error}");
            assert_eq!(
                target.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
    }

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

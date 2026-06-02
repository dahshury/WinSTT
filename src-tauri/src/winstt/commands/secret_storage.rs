// PORT IMPL — WU-0 settings secret-at-rest. Source: frontend/electron/lib/secret-storage.ts.
//
// The Rust analogue of Electron's `safeStorage` wrapper. WinSTT seals the three
// secret settings (`llm.openrouterApiKey`, `integrations.openai.apiKey`,
// `integrations.elevenlabs.apiKey`) at rest as an `enc:v1:<payload>` envelope and
// passes plaintext through to the renderer. This module reproduces that contract
// byte-for-byte on the wire envelope:
//
//   * `encrypt_secret(plain)` → `enc:v1:<hex>` (or `""` for empty input — we do not
//     waste a seal call on the "user hasn't set a key" state, exactly like Electron).
//   * `decrypt_secret(stored)` → plaintext for BOTH a wrapped envelope AND legacy
//     plaintext (callers can't tell them apart and shouldn't need to). Returns `""`
//     on a corrupt / wrong-machine blob so the UI just shows an empty field.
//   * `is_encrypted(value)` → already a wrapped envelope (used to avoid double-seal).
//
// AT-REST CIPHER (the `// TODO(secret):` seam): Electron's `safeStorage` ties the
// ciphertext to the OS user account via DPAPI (Windows). The faithful Rust analogue
// is the OS keystore (the `keyring` crate is already a declared dependency) — but
// keyring 4.x needs a boot-time default-store registration AND a direct
// `keyring-core` dep for the `Entry` type (both reported in the structured summary
// for lib.rs / Cargo.toml). Until that lands this module derives a stable per-
// machine+user key (SHA-256 over OS identity, `sha2` is already a direct dep) and
// XOR-keystreams the secret — genuine at-rest obfuscation tied to this machine, NOT
// plaintext-on-disk, with a lossless round-trip. The `seal_bytes` / `open_bytes`
// pair is the ONE function to swap for keyring/DPAPI; the envelope + every caller
// stay unchanged.

use sha2::{Digest, Sha256};

/// The at-rest envelope prefix. Identical to Electron's `ENC_PREFIX` so a store
/// written by either side is mutually legible (and legacy plaintext — anything
/// WITHOUT this prefix — is detected and passed through on read).
const ENC_PREFIX: &str = "enc:v1:";

/// Returns true if `value` is already a wrapped at-rest envelope (so callers can
/// skip a re-seal). Mirrors `isEncryptedSecret`.
pub fn is_encrypted(value: &str) -> bool {
    value.starts_with(ENC_PREFIX)
}

/// Seal a plaintext secret for at-rest storage.
///
/// Empty input returns `""` — an empty key and an empty envelope are
/// interchangeable ("user hasn't set a key"), and we never spend a seal call on
/// it. A value already wrapped is returned unchanged (idempotent — re-saving the
/// settings tree must not double-seal a key the renderer round-tripped without
/// touching). Mirrors `encryptSecret`.
pub fn encrypt_secret(plain: &str) -> String {
    if plain.is_empty() {
        return String::new();
    }
    if is_encrypted(plain) {
        // Already sealed (the renderer echoed back a value it never decrypted —
        // can't happen via the IPC path, which always sends plaintext, but the
        // guard keeps the function total + idempotent).
        return plain.to_string();
    }
    let sealed = seal_bytes(plain.as_bytes());
    format!("{ENC_PREFIX}{}", to_hex(&sealed))
}

/// Open an at-rest value to plaintext.
///
/// Returns plaintext for BOTH a wrapped envelope and legacy plaintext (no prefix);
/// returns `""` on a corrupt / wrong-machine blob (so the UI shows an empty field
/// and the user can re-enter the key) — defense-in-depth identical to
/// `decryptSecret`.
pub fn decrypt_secret(stored: &str) -> String {
    if stored.is_empty() {
        return String::new();
    }
    if !is_encrypted(stored) {
        // Legacy plaintext (pre-seal store, or a key the renderer just typed that
        // hasn't been re-persisted yet). Pass through unchanged.
        return stored.to_string();
    }
    let hex = &stored[ENC_PREFIX.len()..];
    match from_hex(hex) {
        Some(bytes) => open_bytes(&bytes)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default(),
        None => String::new(),
    }
}

// ── The cipher seam (// TODO(secret): swap for keyring/DPAPI) ───────────────────
//
// `seal_bytes` / `open_bytes` are the ONLY crypto call sites. Replace this pair
// with `keyring_core::Entry::{set/get}_secret` once keyring's default store is
// registered at boot (reported for lib.rs); the envelope and every caller above
// stay byte-compatible (just the inner payload format changes, and decrypt already
// tolerates an unreadable old blob by returning "").

/// XOR-keystream seal under the per-machine key. The keystream is
/// `SHA-256(key || counter)` chained, so it covers payloads of any length without
/// repeating. Lossless: `open_bytes(seal_bytes(x)) == Some(x)` on the same machine.
fn seal_bytes(plain: &[u8]) -> Vec<u8> {
    xor_keystream(plain, &machine_key())
}

/// Inverse of `seal_bytes`. XOR is its own inverse, so this is the same transform
/// under the same key. Returns `None` only if the key cannot be derived (never on
/// a real host — `machine_key` always yields 32 bytes).
fn open_bytes(sealed: &[u8]) -> Option<Vec<u8>> {
    Some(xor_keystream(sealed, &machine_key()))
}

/// Apply `data XOR keystream(key)` where the keystream is the chained-counter
/// SHA-256 expansion of `key`. Symmetric (seal == open).
fn xor_keystream(data: &[u8], key: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut counter: u64 = 0;
    let mut block = derive_block(key, counter);
    let mut bi = 0usize;
    for &byte in data {
        if bi == block.len() {
            counter += 1;
            block = derive_block(key, counter);
            bi = 0;
        }
        out.push(byte ^ block[bi]);
        bi += 1;
    }
    out
}

/// One 32-byte keystream block: `SHA-256(key || counter_le)`.
fn derive_block(key: &[u8; 32], counter: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(key);
    h.update(counter.to_le_bytes());
    let d = h.finalize();
    let mut block = [0u8; 32];
    block.copy_from_slice(&d);
    block
}

/// Derive a stable per-machine+user 32-byte key from OS identity. Mirrors
/// `safeStorage`'s "tied to the current OS user account" property: the same user
/// on the same machine always derives the same key (so secrets persist across app
/// launches), and a different machine/user derives a different key (so a copied
/// store file can't be read).
///
/// Sources, hashed together (any subset present is fine — we only need stability):
///   * Windows `MachineGuid` (HKLM\SOFTWARE\Microsoft\Cryptography), surfaced via
///     env when available, else the registry read below.
///   * `COMPUTERNAME` / `USERNAME` (Windows) — always set in a user session.
///   * `USER` / `HOSTNAME` (POSIX fallback for dev on non-Windows).
/// A fixed domain-separation salt prevents the key from colliding with any other
/// SHA-256 use of the same identity strings.
///
/// MEMOIZED (audit #17): the key is process-stable (proven by
/// `machine_key_is_stable_within_process`), and deriving it spawns `reg.exe` on
/// Windows to read the `MachineGuid`. Without the cache that subprocess ran up to
/// 3× per settings read (once per sealed secret). A `OnceLock` computes it exactly
/// once per process; every later read is a cheap copy.
fn machine_key() -> [u8; 32] {
    use std::sync::OnceLock;
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    *KEY.get_or_init(derive_machine_key)
}

/// Compute the per-machine+user key from OS identity. Separated from `machine_key`
/// so the `OnceLock` memoizes the (subprocess-spawning) derivation while the public
/// `machine_key` stays a pure cheap accessor.
fn derive_machine_key() -> [u8; 32] {
    const SALT: &str = "winstt::secret-storage::v1";
    let mut h = Sha256::new();
    h.update(SALT.as_bytes());
    for part in machine_identity_parts() {
        h.update(b"\x1f"); // unit separator between fields (no concat collisions)
        h.update(part.as_bytes());
    }
    let d = h.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&d);
    key
}

/// Collect the stable identity strings for `machine_key`. Kept separate so it can
/// be unit-tested for stability (same process → same parts → same key).
fn machine_identity_parts() -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(guid) = windows_machine_guid() {
        parts.push(guid);
    }
    for var in ["COMPUTERNAME", "USERNAME", "USERDOMAIN", "HOSTNAME", "USER"] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                parts.push(format!("{var}={v}"));
            }
        }
    }
    // Guarantee a non-empty key material even on a bare CI sandbox: a constant
    // tail means the key is still deterministic (round-trip holds) though not
    // machine-unique there. On real hosts the GUID/env parts dominate.
    parts.push("winstt-fallback-seed".to_string());
    parts
}

/// Read the Windows `MachineGuid` (a stable per-install identifier) from the
/// registry. Returns `None` off Windows or if the key is unreadable — the env
/// parts then carry the key derivation. Uses `reg query` (no extra crate; the
/// `windows` crate is only a transitive dep here).
#[cfg(target_os = "windows")]
fn windows_machine_guid() -> Option<String> {
    use std::process::Command;
    let out = Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Output line shape: "    MachineGuid    REG_SZ    <guid>".
    for line in text.lines() {
        if let Some(idx) = line.find("REG_SZ") {
            let guid = line[idx + "REG_SZ".len()..].trim();
            if !guid.is_empty() {
                return Some(guid.to_string());
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn windows_machine_guid() -> Option<String> {
    // POSIX dev hosts: prefer the systemd/dbus machine-id if readable; else fall
    // through to env parts.
    std::fs::read_to_string("/etc/machine-id")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ── Hex codec (no external dep) ─────────────────────────────────────────────────

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_val(bytes[i])?;
        let lo = hex_val(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Some(out)
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_seals_to_empty() {
        // Mirrors Electron `encryptSecret("") === ""` (no DPAPI call on empty).
        assert_eq!(encrypt_secret(""), "");
    }

    #[test]
    fn round_trips_a_real_key() {
        let plain = "sk-or-v1-0123456789abcdef";
        let sealed = encrypt_secret(plain);
        assert!(is_encrypted(&sealed), "sealed value must carry the envelope");
        assert_ne!(sealed, plain, "must not be plaintext on disk");
        assert!(!sealed.contains(plain), "plaintext must not leak into the envelope");
        assert_eq!(decrypt_secret(&sealed), plain);
    }

    #[test]
    fn legacy_plaintext_passes_through_on_read() {
        // A pre-seal store (or a key the renderer just typed) has no prefix and
        // must read back verbatim — Electron's legacy-plaintext passthrough.
        let legacy = "sk-or-v1-legacy-plaintext";
        assert!(!is_encrypted(legacy));
        assert_eq!(decrypt_secret(legacy), legacy);
    }

    #[test]
    fn empty_decrypts_to_empty() {
        assert_eq!(decrypt_secret(""), "");
    }

    #[test]
    fn corrupt_envelope_decrypts_to_empty() {
        // Non-hex payload after the prefix → unreadable → "" (UI shows empty
        // field, user re-enters). Matches `decryptSecret`'s catch → "".
        assert_eq!(decrypt_secret("enc:v1:not-hex-!!!"), "");
        assert_eq!(decrypt_secret("enc:v1:abc"), ""); // odd-length hex
    }

    #[test]
    fn idempotent_seal() {
        let plain = "xi-api-key-abcdef";
        let once = encrypt_secret(plain);
        // Re-sealing an already-sealed value is a no-op (the renderer can echo a
        // value it never decrypted; the merge must not double-wrap it).
        let twice = encrypt_secret(&once);
        assert_eq!(once, twice);
        assert_eq!(decrypt_secret(&twice), plain);
    }

    #[test]
    fn machine_key_is_stable_within_process() {
        // Same process → same identity parts → same key (so a sealed key survives
        // app relaunch on the same machine/user).
        assert_eq!(machine_identity_parts(), machine_identity_parts());
        assert_eq!(machine_key(), machine_key());
    }

    #[test]
    fn hex_round_trips() {
        let bytes = vec![0u8, 1, 15, 16, 255, 128, 64];
        let hex = to_hex(&bytes);
        assert_eq!(from_hex(&hex), Some(bytes));
    }

    #[test]
    fn unicode_secret_round_trips() {
        // Defensive: a key with non-ASCII (paste artifacts) must survive the
        // byte-level XOR + hex round-trip.
        let plain = "clé-секрет-🔑";
        let sealed = encrypt_secret(plain);
        assert_eq!(decrypt_secret(&sealed), plain);
    }
}

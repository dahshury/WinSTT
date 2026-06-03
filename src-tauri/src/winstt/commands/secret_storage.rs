// PORT IMPL - WU-0 settings secret-at-rest. Source: frontend/electron/lib/secret-storage.ts.
//
// This is the Rust analogue of Electron's `safeStorage` wrapper: the persisted
// settings tree carries an `enc:v1:<hex>` envelope, while IPC callers continue to
// receive plaintext. On Windows, the envelope payload is protected with DPAPI,
// tying it to the current OS user account. There is no local crypto fallback:
// malformed envelopes or unavailable OS storage fail explicitly instead of being
// treated as "empty secret".

/// The at-rest envelope prefix. Legacy plaintext - anything without this prefix -
/// is still passed through so existing unsealed settings can be re-saved sealed.
const ENC_PREFIX: &str = "enc:v1:";

/// Returns true if `value` is already a wrapped at-rest envelope.
pub fn is_encrypted(value: &str) -> bool {
    value.starts_with(ENC_PREFIX)
}

/// Seal a plaintext secret for at-rest storage.
///
/// Empty input returns `""`: an empty key and an empty envelope both mean "unset".
/// A value already wrapped is returned unchanged so re-saving the settings tree
/// does not double-seal an encrypted value.
pub fn encrypt_secret(plain: &str) -> String {
    if plain.is_empty() {
        return String::new();
    }
    if is_encrypted(plain) {
        return plain.to_string();
    }

    let sealed = seal_bytes(plain.as_bytes()).unwrap_or_else(|err| {
        panic!("secret storage: failed to encrypt secret with OS-protected storage: {err}")
    });
    format!("{ENC_PREFIX}{}", to_hex(&sealed))
}

/// Open an at-rest value to plaintext.
///
/// Returns plaintext for both a wrapped envelope and legacy plaintext (no prefix).
/// Corrupt envelopes and OS storage failures are explicit failures; returning an
/// empty string here would hide data loss and can trick callers into persisting a
/// cleared API key.
pub fn decrypt_secret(stored: &str) -> String {
    if stored.is_empty() {
        return String::new();
    }
    if !is_encrypted(stored) {
        return stored.to_string();
    }

    let hex = &stored[ENC_PREFIX.len()..];
    let bytes = from_hex(hex)
        .unwrap_or_else(|| panic!("secret storage: malformed encrypted secret envelope"));
    let plain = open_bytes(&bytes).unwrap_or_else(|err| {
        panic!("secret storage: failed to decrypt secret with OS-protected storage: {err}")
    });
    String::from_utf8(plain)
        .unwrap_or_else(|_| panic!("secret storage: decrypted secret is not valid UTF-8"))
}

// -- OS-protected storage ------------------------------------------------------

#[cfg(target_os = "windows")]
fn seal_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows::core::w;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plain
            .len()
            .try_into()
            .map_err(|_| "secret exceeds DPAPI input length".to_string())?,
        pbData: plain.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptProtectData(
            &input,
            w!("WinSTT secret"),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|err| format!("CryptProtectData failed: {err}"))?;

        let sealed = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(sealed)
    }
}

#[cfg(target_os = "windows")]
fn open_bytes(sealed: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: sealed
            .len()
            .try_into()
            .map_err(|_| "encrypted payload exceeds DPAPI input length".to_string())?,
        pbData: sealed.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|err| format!("CryptUnprotectData failed: {err}"))?;

        let plain = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(plain)
    }
}

#[cfg(not(target_os = "windows"))]
fn seal_bytes(_plain: &[u8]) -> Result<Vec<u8>, String> {
    Err(
        "WinSTT secret storage requires Windows DPAPI; no plaintext or XOR fallback is enabled"
            .to_string(),
    )
}

#[cfg(not(target_os = "windows"))]
fn open_bytes(_sealed: &[u8]) -> Result<Vec<u8>, String> {
    Err(
        "WinSTT secret storage requires Windows DPAPI; no plaintext or XOR fallback is enabled"
            .to_string(),
    )
}

// -- Hex codec ----------------------------------------------------------------

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
    if !bytes.len().is_multiple_of(2) {
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
        assert_eq!(encrypt_secret(""), "");
    }

    #[test]
    fn empty_decrypts_to_empty() {
        assert_eq!(decrypt_secret(""), "");
    }

    #[test]
    fn legacy_plaintext_passes_through_on_read() {
        let legacy = "sk-or-v1-legacy-plaintext";
        assert!(!is_encrypted(legacy));
        assert_eq!(decrypt_secret(legacy), legacy);
    }

    #[test]
    fn idempotent_seal() {
        let already_sealed = "enc:v1:feedface";
        assert_eq!(encrypt_secret(already_sealed), already_sealed);
    }

    #[test]
    #[should_panic(expected = "secret storage: malformed encrypted secret envelope")]
    fn corrupt_envelope_does_not_decrypt_to_empty() {
        let _ = decrypt_secret("enc:v1:not-hex-!!!");
    }

    #[test]
    #[should_panic(expected = "secret storage: malformed encrypted secret envelope")]
    fn odd_length_envelope_does_not_decrypt_to_empty() {
        let _ = decrypt_secret("enc:v1:abc");
    }

    #[test]
    fn hex_round_trips() {
        let bytes = vec![0u8, 1, 15, 16, 255, 128, 64];
        let hex = to_hex(&bytes);
        assert_eq!(from_hex(&hex), Some(bytes));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn round_trips_a_real_key_with_dpapi() {
        let plain = "sk-or-v1-0123456789abcdef";
        let sealed = encrypt_secret(plain);

        assert!(is_encrypted(&sealed));
        assert_ne!(sealed, plain, "must not be plaintext on disk");
        assert!(
            !sealed.contains(plain),
            "plaintext must not leak into envelope"
        );
        assert_ne!(
            sealed,
            encrypt_secret(plain),
            "DPAPI should include per-seal randomness"
        );
        assert_eq!(decrypt_secret(&sealed), plain);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn unicode_secret_round_trips_with_dpapi() {
        let plain = "cle-\u{00e9}-secret-\u{1f511}";
        let sealed = encrypt_secret(plain);
        assert_eq!(decrypt_secret(&sealed), plain);
    }
}

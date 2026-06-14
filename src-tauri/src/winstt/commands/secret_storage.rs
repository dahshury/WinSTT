// Settings secret-at-rest.
//
// The persisted settings tree carries an `enc:v1:<hex>` envelope, while IPC callers
// continue to receive plaintext. On Windows, the envelope payload is protected with DPAPI,
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
    try_encrypt_secret(plain).unwrap_or_else(|err| panic!("{err}"))
}

pub fn try_encrypt_secret(plain: &str) -> Result<String, String> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    if is_encrypted(plain) {
        return Ok(plain.to_string());
    }

    let sealed = seal_bytes(plain.as_bytes()).map_err(|err| {
        format!("secret storage: failed to encrypt secret with OS-protected storage: {err}")
    })?;
    Ok(format!("{ENC_PREFIX}{}", to_hex(&sealed)))
}

/// Open an at-rest value to plaintext.
///
/// Returns plaintext for both a wrapped envelope and legacy plaintext (no prefix).
/// Corrupt envelopes and OS storage failures are explicit failures; returning an
/// empty string here would hide data loss and can trick callers into persisting a
/// cleared API key.
pub fn decrypt_secret(stored: &str) -> String {
    try_decrypt_secret(stored).unwrap_or_else(|err| panic!("{err}"))
}

pub fn try_decrypt_secret(stored: &str) -> Result<String, String> {
    if stored.is_empty() {
        return Ok(String::new());
    }
    if !is_encrypted(stored) {
        return Ok(stored.to_string());
    }

    let hex = &stored[ENC_PREFIX.len()..];
    let bytes = from_hex(hex)
        .ok_or_else(|| "secret storage: malformed encrypted secret envelope".to_string())?;
    let plain = open_bytes(&bytes).map_err(|err| {
        format!("secret storage: failed to decrypt secret with OS-protected storage: {err}")
    })?;
    String::from_utf8(plain)
        .map_err(|_| "secret storage: decrypted secret is not valid UTF-8".to_string())
}

// -- OS-protected storage ------------------------------------------------------

#[cfg(target_os = "windows")]
fn seal_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows::core::w;
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

    // SAFETY: `input` points at `plain`, which outlives the call. On success,
    // DPAPI initializes `output` with a LocalAlloc-owned buffer; `DpapiBlob`
    // takes ownership immediately and frees it in Drop.
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

        let sealed = DpapiBlob::from_crypt_blob(output, "CryptProtectData")?;
        Ok(sealed.to_vec())
    }
}

#[cfg(target_os = "windows")]
fn open_bytes(sealed: &[u8]) -> Result<Vec<u8>, String> {
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

    // SAFETY: `input` points at `sealed`, which outlives the call. On success,
    // DPAPI initializes `output` with a LocalAlloc-owned buffer; `DpapiBlob`
    // takes ownership immediately and frees it in Drop.
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

        let plain = DpapiBlob::from_crypt_blob(output, "CryptUnprotectData")?;
        Ok(plain.to_vec())
    }
}

#[cfg(target_os = "windows")]
struct DpapiBlob {
    ptr: *mut u8,
    len: usize,
}

#[cfg(target_os = "windows")]
impl DpapiBlob {
    fn from_crypt_blob(
        blob: windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB,
        source: &str,
    ) -> Result<Self, String> {
        let len = usize::try_from(blob.cbData)
            .map_err(|_| format!("{source} returned an oversized output blob"))?;
        if len > 0 && blob.pbData.is_null() {
            return Err(format!("{source} returned a null output buffer"));
        }
        Ok(Self {
            ptr: blob.pbData,
            len,
        })
    }

    fn to_vec(&self) -> Vec<u8> {
        if self.len == 0 {
            return Vec::new();
        }
        // SAFETY: `from_crypt_blob` rejects null non-empty buffers and DPAPI
        // owns `ptr` until this guard is dropped.
        unsafe { std::slice::from_raw_parts(self.ptr, self.len).to_vec() }
    }
}

#[cfg(target_os = "windows")]
impl Drop for DpapiBlob {
    fn drop(&mut self) {
        if self.ptr.is_null() {
            return;
        }
        // SAFETY: DPAPI allocates output buffers with LocalAlloc; LocalFree is
        // the documented deallocator and is called exactly once by this guard.
        unsafe {
            let _ = windows::Win32::Foundation::LocalFree(Some(
                windows::Win32::Foundation::HLOCAL(self.ptr.cast()),
            ));
        }
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
    fn corrupt_envelope_does_not_decrypt_to_empty() {
        assert_eq!(
            try_decrypt_secret("enc:v1:not-hex-!!!").unwrap_err(),
            "secret storage: malformed encrypted secret envelope"
        );
    }

    #[test]
    fn odd_length_envelope_does_not_decrypt_to_empty() {
        assert_eq!(
            try_decrypt_secret("enc:v1:abc").unwrap_err(),
            "secret storage: malformed encrypted secret envelope"
        );
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

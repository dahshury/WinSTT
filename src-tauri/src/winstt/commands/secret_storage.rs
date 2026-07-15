// Settings secret-at-rest.
//
// The persisted settings tree carries an `enc:v1:<hex>` envelope, while IPC callers
// continue to receive plaintext. On Windows, the envelope payload is protected with DPAPI,
// tying it to the current OS user account. On macOS/Linux the payload is AEAD-sealed with a
// per-install 256-bit master key that lives in the OS keychain (macOS Keychain / Linux Secret
// Service via the `keyring` crate); the sealed value stays self-describing on disk while the
// protection key never leaves the keychain. Either way there is no plaintext or XOR fallback:
// malformed envelopes or unavailable OS storage fail explicitly instead of being treated as
// "empty secret".

/// The at-rest envelope prefix.
const ENC_PREFIX: &str = "enc:v1:";

/// Returns true if `value` is already a wrapped at-rest envelope.
pub fn is_encrypted(value: &str) -> bool {
    value.starts_with(ENC_PREFIX)
}

/// Seal a plaintext secret for at-rest storage.
///
/// Empty input returns `""`: an empty key and an empty envelope both mean "unset".
pub fn encrypt_secret(plain: &str) -> Result<String, String> {
    try_encrypt_secret(plain)
}

pub fn try_encrypt_secret(plain: &str) -> Result<String, String> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    if is_encrypted(plain) {
        return Err("secret storage: expected plaintext secret".to_string());
    }

    let sealed = seal_bytes(plain.as_bytes()).map_err(|err| {
        format!("secret storage: failed to encrypt secret with OS-protected storage: {err}")
    })?;
    Ok(format!("{ENC_PREFIX}{}", to_hex(&sealed)))
}

/// Open an at-rest value to plaintext.
///
/// Corrupt or unwrapped values and OS storage failures are explicit failures; returning an
/// empty string here would hide data loss and can trick callers into persisting a
/// cleared API key.
pub fn decrypt_secret(stored: &str) -> Result<String, String> {
    try_decrypt_secret(stored)
}

pub fn try_decrypt_secret(stored: &str) -> Result<String, String> {
    if stored.is_empty() {
        return Ok(String::new());
    }
    if !is_encrypted(stored) {
        return Err("secret storage: expected encrypted secret envelope".to_string());
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
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };
    use windows::core::w;

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
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
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

// -- Non-Windows OS keychain + AEAD -------------------------------------------
//
// Windows has DPAPI, which returns an opaque self-contained blob. The OS keychains on
// macOS/Linux instead store by (service, account), so we keep a single per-install random
// 256-bit master key there and AEAD-seal each secret with it. The sealed envelope on disk is
// `nonce || ciphertext || tag`; only the master key lives in the keychain.
//
// The AEAD is a standard encrypt-then-MAC construction over HMAC-SHA256 (the pure-Rust `sha2`
// already vendored for download checksums): per-message encryption/authentication subkeys are
// derived with HKDF-SHA256 salted by the random nonce, the plaintext is XORed with an
// HMAC-SHA256 counter-mode keystream, and the ciphertext is authenticated with HMAC-SHA256.
// This is a real AEAD (a PRF-keystream stream cipher plus encrypt-then-MAC), not a static-key
// XOR obfuscation. A dedicated AEAD crate (chacha20poly1305/aes-gcm) is not in the dependency
// tree; this keeps the backend to the `keyring` + `sha2` crates that are.

#[cfg(not(target_os = "windows"))]
const KEYCHAIN_SERVICE: &str = "WinSTT";
#[cfg(not(target_os = "windows"))]
const KEYCHAIN_ACCOUNT: &str = "winstt-secret-master-key";
#[cfg(not(target_os = "windows"))]
const HKDF_INFO: &[u8] = b"WinSTT secret storage v1";
#[cfg(not(target_os = "windows"))]
const MASTER_KEY_LEN: usize = 32;
#[cfg(not(target_os = "windows"))]
const NONCE_LEN: usize = 24;
#[cfg(not(target_os = "windows"))]
const TAG_LEN: usize = 32;

#[cfg(not(target_os = "windows"))]
fn seal_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
    let master = keychain_master_key()?;
    aead_seal(&master, plain)
}

#[cfg(not(target_os = "windows"))]
fn open_bytes(sealed: &[u8]) -> Result<Vec<u8>, String> {
    let master = keychain_master_key()?;
    aead_open(&master, sealed)
}

/// Fetch the per-install master key from the OS keychain, minting and persisting a fresh
/// random one on first use. A locked/unavailable keychain is a graceful `Err` (never a panic
/// and never a silent plaintext fallback), so the caller aborts the seal instead of writing an
/// unprotected key to disk.
#[cfg(not(target_os = "windows"))]
fn keychain_master_key() -> Result<[u8; MASTER_KEY_LEN], String> {
    use keyring::{Entry, Error};

    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|err| format!("open OS keychain entry: {err}"))?;

    match entry.get_password() {
        Ok(stored) => decode_master_key(stored.trim()),
        Err(Error::NoEntry) => {
            // First run on this install: mint a fresh 256-bit key and persist it. WinSTT runs
            // as a single desktop instance, so a concurrent create racing this branch is not a
            // practical concern.
            let mut key = [0u8; MASTER_KEY_LEN];
            fill_random(&mut key)?;
            entry
                .set_password(&to_hex(&key))
                .map_err(|err| format!("write master key to OS keychain: {err}"))?;
            Ok(key)
        }
        Err(err) => Err(format!("read master key from OS keychain: {err}")),
    }
}

#[cfg(not(target_os = "windows"))]
fn decode_master_key(hex: &str) -> Result<[u8; MASTER_KEY_LEN], String> {
    let bytes = from_hex(hex).ok_or_else(|| "OS keychain master key is malformed".to_string())?;
    if bytes.len() != MASTER_KEY_LEN {
        return Err("OS keychain master key has unexpected length".to_string());
    }
    let mut key = [0u8; MASTER_KEY_LEN];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// AEAD-seal `plain` as `nonce || ciphertext || tag` (encrypt-then-MAC).
#[cfg(not(target_os = "windows"))]
fn aead_seal(master: &[u8; MASTER_KEY_LEN], plain: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; NONCE_LEN];
    fill_random(&mut nonce)?;

    let okm = hkdf_sha256_64(master, &nonce, HKDF_INFO);
    let (enc_key, mac_key) = okm.split_at(32);

    let mut ciphertext = plain.to_vec();
    xor_keystream(enc_key, &nonce, &mut ciphertext);

    let tag = hmac_sha256(mac_key, &[&nonce[..], &ciphertext[..]].concat());

    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len() + TAG_LEN);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    out.extend_from_slice(&tag);
    Ok(out)
}

/// Reverse [`aead_seal`]. Authentication is verified before decryption; a wrong key or a
/// tampered/corrupt envelope is an explicit `Err` rather than garbage plaintext.
#[cfg(not(target_os = "windows"))]
fn aead_open(master: &[u8; MASTER_KEY_LEN], sealed: &[u8]) -> Result<Vec<u8>, String> {
    if sealed.len() < NONCE_LEN + TAG_LEN {
        return Err("secret storage: sealed secret is truncated".to_string());
    }
    let (nonce, rest) = sealed.split_at(NONCE_LEN);
    let (ciphertext, tag) = rest.split_at(rest.len() - TAG_LEN);

    let okm = hkdf_sha256_64(master, nonce, HKDF_INFO);
    let (enc_key, mac_key) = okm.split_at(32);

    let expected = hmac_sha256(mac_key, &[nonce, ciphertext].concat());
    if !ct_eq(&expected, tag) {
        return Err(
            "secret storage: authentication failed (wrong key or corrupted secret)".to_string(),
        );
    }

    let mut plain = ciphertext.to_vec();
    xor_keystream(enc_key, nonce, &mut plain);
    Ok(plain)
}

/// XOR `data` in place with an HMAC-SHA256 counter-mode keystream keyed by `enc_key`.
/// `enc_key` is a fresh per-message subkey (HKDF-salted by the nonce), so a plain big-endian
/// block counter is sufficient to keep every block's keystream distinct.
#[cfg(not(target_os = "windows"))]
fn xor_keystream(enc_key: &[u8], nonce: &[u8], data: &mut [u8]) {
    let mut counter: u64 = 0;
    let mut offset = 0;
    while offset < data.len() {
        let mut block_input = Vec::with_capacity(nonce.len() + 8);
        block_input.extend_from_slice(nonce);
        block_input.extend_from_slice(&counter.to_be_bytes());
        let ks = hmac_sha256(enc_key, &block_input);

        let n = core::cmp::min(ks.len(), data.len() - offset);
        for (dst, k) in data[offset..offset + n].iter_mut().zip(ks.iter()) {
            *dst ^= *k;
        }
        offset += n;
        counter += 1;
    }
}

/// HKDF-SHA256 producing 64 bytes of output keying material (RFC 5869).
#[cfg(not(target_os = "windows"))]
fn hkdf_sha256_64(ikm: &[u8], salt: &[u8], info: &[u8]) -> [u8; 64] {
    // Extract.
    let prk = hmac_sha256(salt, ikm);

    // Expand for L = 64 bytes => two blocks (T(1), T(2)).
    let mut t1_input = Vec::with_capacity(info.len() + 1);
    t1_input.extend_from_slice(info);
    t1_input.push(0x01);
    let t1 = hmac_sha256(&prk, &t1_input);

    let mut t2_input = Vec::with_capacity(t1.len() + info.len() + 1);
    t2_input.extend_from_slice(&t1);
    t2_input.extend_from_slice(info);
    t2_input.push(0x02);
    let t2 = hmac_sha256(&prk, &t2_input);

    let mut okm = [0u8; 64];
    okm[..32].copy_from_slice(&t1);
    okm[32..].copy_from_slice(&t2);
    okm
}

/// HMAC-SHA256 (RFC 2104) over the vendored pure-Rust `sha2`.
#[cfg(not(target_os = "windows"))]
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};

    const BLOCK: usize = 64;
    let mut block_key = [0u8; BLOCK];
    if key.len() > BLOCK {
        let digest = Sha256::digest(key);
        block_key[..32].copy_from_slice(&digest);
    } else {
        block_key[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= block_key[i];
        opad[i] ^= block_key[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);

    let mut out = [0u8; 32];
    out.copy_from_slice(&outer.finalize());
    out
}

/// Constant-time equality to avoid leaking tag-comparison timing.
#[cfg(not(target_os = "windows"))]
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Fill `buf` with cryptographically secure random bytes from the OS.
/// `/dev/urandom` is the non-blocking CSPRNG on both macOS and Linux.
#[cfg(not(target_os = "windows"))]
fn fill_random(buf: &mut [u8]) -> Result<(), String> {
    use std::io::Read;

    let mut file = std::fs::File::open("/dev/urandom")
        .map_err(|err| format!("open /dev/urandom for secret randomness: {err}"))?;
    file.read_exact(buf)
        .map_err(|err| format!("read /dev/urandom for secret randomness: {err}"))
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
        assert_eq!(encrypt_secret("").as_deref(), Ok(""));
    }

    #[test]
    fn empty_decrypts_to_empty() {
        assert_eq!(decrypt_secret("").as_deref(), Ok(""));
    }

    #[test]
    fn plaintext_is_rejected_on_read() {
        let plaintext = "sk-or-v1-plaintext";
        assert!(!is_encrypted(plaintext));
        assert_eq!(
            decrypt_secret(plaintext).unwrap_err(),
            "secret storage: expected encrypted secret envelope"
        );
    }

    #[test]
    fn encrypted_input_is_rejected_by_seal() {
        let already_sealed = "enc:v1:feedface";
        assert_eq!(
            encrypt_secret(already_sealed).unwrap_err(),
            "secret storage: expected plaintext secret"
        );
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
        let sealed = encrypt_secret(plain).expect("seal with DPAPI");

        assert!(is_encrypted(&sealed));
        assert_ne!(sealed, plain, "must not be plaintext on disk");
        assert!(
            !sealed.contains(plain),
            "plaintext must not leak into envelope"
        );
        assert_ne!(
            sealed,
            encrypt_secret(plain).expect("seal with DPAPI"),
            "DPAPI should include per-seal randomness"
        );
        assert_eq!(decrypt_secret(&sealed).as_deref(), Ok(plain));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn unicode_secret_round_trips_with_dpapi() {
        let plain = "cle-\u{00e9}-secret-\u{1f511}";
        let sealed = encrypt_secret(plain).expect("seal with DPAPI");
        assert_eq!(decrypt_secret(&sealed).as_deref(), Ok(plain));
    }

    // The non-Windows AEAD layer is tested against a fixed master key so it does not depend on
    // a live OS keychain (unavailable on headless CI). The keychain glue (`keychain_master_key`
    // / `seal_bytes` / `open_bytes`) is exercised at runtime on real macOS/Linux hosts.
    #[cfg(not(target_os = "windows"))]
    mod non_windows_aead {
        use super::super::{MASTER_KEY_LEN, NONCE_LEN, TAG_LEN, aead_open, aead_seal, hmac_sha256};

        const MASTER: [u8; MASTER_KEY_LEN] = [7u8; MASTER_KEY_LEN];

        #[test]
        fn hmac_sha256_matches_rfc4231_vector() {
            // RFC 4231 test case 2.
            let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
            let expected = super::super::from_hex(
                "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
            )
            .expect("hex vector");
            assert_eq!(mac.as_slice(), expected.as_slice());
        }

        #[test]
        fn aead_round_trips_a_real_key() {
            let plain = b"sk-or-v1-0123456789abcdef";
            let sealed = aead_seal(&MASTER, plain).expect("seal");
            assert!(sealed.len() >= NONCE_LEN + TAG_LEN);
            assert_ne!(&sealed[NONCE_LEN..sealed.len() - TAG_LEN], &plain[..]);
            assert_eq!(aead_open(&MASTER, &sealed).unwrap(), plain);
        }

        #[test]
        fn aead_seal_is_nondeterministic() {
            let plain = b"same-input";
            let a = aead_seal(&MASTER, plain).expect("seal");
            let b = aead_seal(&MASTER, plain).expect("seal");
            assert_ne!(a, b, "fresh nonce per seal");
        }

        #[test]
        fn aead_empty_plaintext_round_trips() {
            let sealed = aead_seal(&MASTER, b"").expect("seal");
            assert_eq!(sealed.len(), NONCE_LEN + TAG_LEN);
            assert_eq!(aead_open(&MASTER, &sealed).unwrap(), b"");
        }

        #[test]
        fn tampered_ciphertext_fails_auth() {
            let mut sealed = aead_seal(&MASTER, b"secret-value").expect("seal");
            let mid = NONCE_LEN + 1;
            sealed[mid] ^= 0xff;
            assert!(aead_open(&MASTER, &sealed).is_err());
        }

        #[test]
        fn wrong_master_key_fails_auth() {
            let sealed = aead_seal(&MASTER, b"secret-value").expect("seal");
            let other = [9u8; MASTER_KEY_LEN];
            assert!(aead_open(&other, &sealed).is_err());
        }

        #[test]
        fn truncated_envelope_is_rejected() {
            assert!(aead_open(&MASTER, &[0u8; NONCE_LEN + TAG_LEN - 1]).is_err());
        }

        #[test]
        fn full_envelope_round_trips_through_hex_layer() {
            // Mirrors the try_encrypt/try_decrypt hex-envelope wrapping with an injected key so
            // the whole path is covered without a keychain.
            let plain = b"cle-\xc3\xa9-secret";
            let sealed = aead_seal(&MASTER, plain).expect("seal");
            let hex = super::super::to_hex(&sealed);
            let back = super::super::from_hex(&hex).expect("hex round-trip");
            assert_eq!(aead_open(&MASTER, &back).unwrap(), plain);
        }
    }
}

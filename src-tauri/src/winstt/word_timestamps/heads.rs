// ═════════════════════════════════════════════════════════════════════════════
// 2. Alignment-heads decode — base85 (RFC1924 == Python b85decode) + gzip.
// ═════════════════════════════════════════════════════════════════════════════

use ndarray::Array2;

use super::{WordTsError, ALIGNMENT_HEADS, EN_VOCAB_SIZE, MODEL_SIZE_BY_DIMS};

/// Decode a base85-gzipped flat bool array into a `(num_layers, num_heads)` mask.
/// Mirrors `decode_alignment_heads` / `Whisper.set_alignment_heads`.
///
/// The blob is ASCII (RFC1924 base85), then gzip; the inflated bytes are a flat
/// bool array (1 byte per bool, NumPy `dtype=bool`) reshaped row-major.
pub fn decode_alignment_heads(
    dump: &str,
    num_layers: usize,
    num_heads: usize,
) -> Result<Array2<bool>, WordTsError> {
    let compressed = base85::decode(dump).map_err(|e| WordTsError::Base85(format!("{e:?}")))?;
    let raw = gzip_inflate(&compressed).map_err(|e| WordTsError::Gzip(e.to_string()))?;
    let expected = num_layers * num_heads;
    if raw.len() != expected {
        return Err(WordTsError::Shape {
            got: raw.len(),
            expected,
            layers: num_layers,
            heads: num_heads,
        });
    }
    // NumPy bool: any nonzero byte is True.
    let flags: Vec<bool> = raw.iter().map(|&b| b != 0).collect();
    Array2::from_shape_vec((num_layers, num_heads), flags).map_err(|_| WordTsError::Shape {
        got: raw.len(),
        expected,
        layers: num_layers,
        heads: num_heads,
    })
}

/// gzip-inflate a buffer (flate2 GzDecoder). Separated so tests can hit it.
fn gzip_inflate(data: &[u8]) -> std::io::Result<Vec<u8>> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut decoder = GzDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out)?;
    Ok(out)
}

/// Pick an alignment-heads mask by Whisper model size. Falls back to "all heads
/// in the upper half of layers" when dims don't match a known model. Mirrors
/// `lookup_alignment_heads`. `.en` is chosen when `vocab_size == 51864` and a
/// `<size>.en` entry exists.
pub fn lookup_alignment_heads(
    num_layers: usize,
    num_heads: usize,
    vocab_size: usize,
) -> Array2<bool> {
    if let Some(size) = MODEL_SIZE_BY_DIMS
        .iter()
        .find(|((l, h), _)| *l == num_layers && *h == num_heads)
        .map(|(_, s)| *s)
    {
        let english_only = vocab_size == EN_VOCAB_SIZE;
        let en_key = format!("{size}.en");
        if english_only && blob_for(&en_key).is_some() {
            return decode_or_fallback(&en_key, num_layers, num_heads);
        }
        return decode_or_fallback(size, num_layers, num_heads);
    }
    fallback_mask(num_layers, num_heads)
}

fn decode_or_fallback(key: &str, num_layers: usize, num_heads: usize) -> Array2<bool> {
    match blob_for(key) {
        Some(blob) => decode_alignment_heads(blob, num_layers, num_heads)
            .unwrap_or_else(|_| fallback_mask(num_layers, num_heads)),
        None => fallback_mask(num_layers, num_heads),
    }
}

pub(super) fn blob_for(key: &str) -> Option<&'static str> {
    ALIGNMENT_HEADS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| *v)
}

/// Default mask: every head in the upper half of layers (Whisper's default when
/// no override was set). `mask[num_layers/2 ..] = true`.
fn fallback_mask(num_layers: usize, num_heads: usize) -> Array2<bool> {
    let mut mask = Array2::from_elem((num_layers, num_heads), false);
    for l in (num_layers / 2)..num_layers {
        for h in 0..num_heads {
            mask[[l, h]] = true;
        }
    }
    mask
}

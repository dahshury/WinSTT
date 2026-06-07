// Source: E:/DL/Projects/onnx-asr/src/onnx_asr/diarization.py
//
// ═════════════════════════════════════════════════════════════════════════════
// 3. Offline AHC complete-linkage (the NON-session path). Pure arithmetic.
//    Verbatim port of diarization.py:201-251.
// 4. Activity-interval hysteresis — PURE state machine.
//    Verbatim port of diarization.py:254-294.
// ═════════════════════════════════════════════════════════════════════════════

use super::types::{dot, l2_normalize};

/// Pairwise cosine distance after L2 norm; flat row-major `(n, n)` matrix.
pub fn cosine_distance_matrix(embeddings: &[Vec<f32>]) -> Vec<Vec<f32>> {
    let units: Vec<Vec<f32>> = embeddings.iter().map(|e| l2_normalize(e)).collect();
    let n = units.len();
    let mut out = vec![vec![0.0f32; n]; n];
    for i in 0..n {
        for j in 0..n {
            let cos = dot(&units[i], &units[j]);
            out[i][j] = (1.0 - cos).clamp(0.0, 2.0);
        }
    }
    out
}

/// Complete-linkage AHC. Either a fixed `num_clusters` or stop when the next
/// merge would exceed `threshold`. Returns a label per input (0-based, compact).
pub fn ahc_complete_linkage(
    distances: &[Vec<f32>],
    num_clusters: Option<usize>,
    threshold: f32,
) -> Vec<i64> {
    let n = distances.len();
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![0];
    }

    // members[keep] = list of original indices in that cluster.
    let mut members: Vec<Option<Vec<usize>>> = (0..n).map(|i| Some(vec![i])).collect();
    let mut dm: Vec<Vec<f32>> = distances.to_vec();
    for (i, row) in dm.iter_mut().enumerate() {
        row[i] = f32::INFINITY;
    }

    let mut live = n;
    while live > 1 {
        // argmin over the whole matrix.
        let mut best = f32::INFINITY;
        let (mut bi, mut bj) = (0usize, 0usize);
        for i in 0..n {
            if members[i].is_none() {
                continue;
            }
            for j in 0..n {
                if members[j].is_none() || i == j {
                    continue;
                }
                if dm[i][j] < best {
                    best = dm[i][j];
                    bi = i;
                    bj = j;
                }
            }
        }
        if bi == bj {
            break;
        }
        if num_clusters.is_none() && best > threshold {
            break;
        }
        if let Some(k) = num_clusters {
            if live <= k {
                break;
            }
        }

        let (keep, drop) = if bi < bj { (bi, bj) } else { (bj, bi) };
        let drop_members = members[drop].take().expect("drop cluster live");
        members[keep]
            .as_mut()
            .expect("keep cluster live")
            .extend(drop_members);

        // Complete linkage: new distance = max(keep, drop) per column.
        #[expect(
            clippy::needless_range_loop,
            reason = "indexes multiple rows of dm (keep/drop/c) by c"
        )]
        for c in 0..n {
            let merged = dm[keep][c].max(dm[drop][c]);
            dm[keep][c] = merged;
            dm[c][keep] = merged;
        }
        dm[keep][keep] = f32::INFINITY;
        #[expect(
            clippy::needless_range_loop,
            reason = "indexes multiple rows of dm (drop/c) by c"
        )]
        for c in 0..n {
            dm[drop][c] = f32::INFINITY;
            dm[c][drop] = f32::INFINITY;
        }
        live -= 1;
    }

    // Relabel surviving clusters by ascending keep-index → compact 0-based ids.
    let mut labels = vec![0i64; n];
    let mut survivors: Vec<(usize, &Vec<usize>)> = members
        .iter()
        .enumerate()
        .filter_map(|(i, m)| m.as_ref().map(|v| (i, v)))
        .collect();
    survivors.sort_by_key(|(i, _)| *i);
    for (new_id, (_, idxs)) in survivors.into_iter().enumerate() {
        for &idx in idxs {
            labels[idx] = new_id as i64;
        }
    }
    labels
}

/// Hysteresis thresholding on a 1-D probability track. Returns half-open
/// `[start_frame, end_frame)` intervals: enter active at `p >= onset`, leave at
/// `p < offset`; merge gaps `< merge_frames`; drop runs `< min_frames`.
pub fn active_intervals(
    probs_one_speaker: &[f32],
    onset: f32,
    offset: f32,
    min_frames: usize,
    merge_frames: usize,
) -> Vec<(usize, usize)> {
    let mut intervals: Vec<(usize, usize)> = Vec::new();
    let n = probs_one_speaker.len();
    let mut state = false;
    let mut start = 0usize;
    for (i, &p) in probs_one_speaker.iter().enumerate() {
        if !state && p >= onset {
            state = true;
            start = i;
        } else if state && p < offset {
            state = false;
            intervals.push((start, i));
        }
    }
    if state {
        intervals.push((start, n));
    }
    if intervals.is_empty() {
        return Vec::new();
    }

    // Merge intervals separated by gaps shorter than `merge_frames`.
    let mut merged: Vec<(usize, usize)> = vec![intervals[0]];
    for &(s, e) in &intervals[1..] {
        let (ps, pe) = *merged.last().expect("non-empty");
        if s - pe < merge_frames {
            *merged.last_mut().expect("non-empty") = (ps, e);
        } else {
            merged.push((s, e));
        }
    }

    // Drop intervals shorter than `min_frames`.
    merged
        .into_iter()
        .filter(|&(s, e)| e - s >= min_frames)
        .collect()
}

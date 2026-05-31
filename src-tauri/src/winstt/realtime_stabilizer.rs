// DRAFT PORT — not yet compiled.
// Sources:
//   - server/src/recorder/application/realtime_stabilizer.py (the algorithm)
//   - server/src/recorder/application/recorder_service.py    (committed-watermark accumulator)
//   - examples/RealtimeSTT/RealtimeSTT/audio_recorder.py:2440-2493,2732-2775 (origin)
//   - memory: project_realtime_stabilizer_port, project_realtime_architecture
//
// ============================================================================
// WHY THIS EXISTS
// ============================================================================
// Whisper is stateless and beam search reranks on changing tail context, so
// feeding it a growing audio buffer produces text that contradicts the previous
// output for the SAME prefix audio. RealtimeSTT fixes this entirely at the TEXT
// layer (not by trimming the audio window):
//
//   1. Append every fresh realtime transcription to a deque of length 2.
//   2. Compute the longest common prefix of the last two transcriptions.
//   3. `stable_safetext` is MONOTONIC: a new prefix is adopted only when its
//      length is >= the current length, so it never shrinks even when Whisper
//      rewrites earlier words.
//   4. Output = stable_safetext + fresh[matching_pos..], where matching_pos is
//      where the last `_TAIL_MATCH_LEN` chars of stable_safetext occur in fresh,
//      searched from the END of fresh so the most recent occurrence wins.
//
// CHARACTER SEMANTICS: the Python operates on `str` (Unicode code points), so
// `commonprefix`, slicing, and the tail window are all CHARACTER-based. This
// port uses `Vec<char>` for every index/slice so multi-byte text (CJK, emoji)
// behaves identically to Python rather than byte-indexing.
//
// ============================================================================
// THE WATERMARK+ACCUMULATOR (recorder_service.py)
// ============================================================================
// The stabilizer alone kills flicker on the FRESH tail. The full live-preview
// design also adds a committed-text accumulator so the preview can grow for the
// whole recording while the model never sees more than ~commit-interval of audio
// per call:
//   - Only audio PAST a frame watermark is transcribed each tick.
//   - Once the fresh region exceeds REALTIME_COMMIT_AFTER_SECONDS, the older
//     portion is transcribed ONCE, appended to committed_text, and the watermark
//     advances (always, even on empty output, so audio isn't re-processed).
//   - The assembled text fed to the stabilizer is `committed + " " + fresh`.
//   - On a fresh recording, reset() wipes committed_text AND the stabilizer.
// `RealtimeAccumulator` below ports the PURE text+watermark bookkeeping; the
// actual transcribe calls + audio slicing stay in the recorder pipeline (the
// transcriber is the heavy ORT subsystem — see PORT/03_*.md), and are injected
// as a closure in `commit_and_publish`.

/// RealtimeSTT default tail-match length (audio_recorder.py:2740).
pub const TAIL_MATCH_LEN: usize = 10;

/// Stabilizes a stream of growing-window realtime transcriptions. One instance
/// per recording: call `reset()` at the start of a new recording, `update()`
/// with each fresh realtime transcription, and emit the returned text to the UI.
#[derive(Debug, Default, Clone)]
pub struct RealtimeStabilizer {
    /// The last two transcriptions (deque maxlen=2). Stored as char vectors so
    /// commonprefix/length comparisons are character-based like Python.
    text_storage: Vec<Vec<char>>,
    /// Monotonic stable prefix (the UI anchor).
    stable_safetext: Vec<char>,
}

impl RealtimeStabilizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Wipe state at the start of a new recording.
    pub fn reset(&mut self) {
        self.text_storage.clear();
        self.stable_safetext.clear();
    }

    /// Current stable safetext (UI anchor), as a String.
    pub fn safetext(&self) -> String {
        self.stable_safetext.iter().collect()
    }

    /// Ingest a new realtime transcription and return the stabilized text.
    ///
    /// `fresh_text` is the FULL assembled realtime text for this tick (e.g.
    /// `committed + " " + fresh_window` in the watermark design). The returned
    /// string is the UI-safe, monotonic-anchored text to display.
    pub fn update(&mut self, fresh_text: &str) -> String {
        let fresh: Vec<char> = normalize(fresh_text).chars().collect();

        // deque(maxlen=2): keep only the last two.
        self.text_storage.push(fresh.clone());
        if self.text_storage.len() > 2 {
            self.text_storage.remove(0);
        }

        // 1. Detect the new stable prefix from the last two transcriptions.
        self.update_stable_prefix();

        // 2. Merge: stable_safetext + fresh[matching_pos..].
        self.merge(&fresh).into_iter().collect()
    }

    /// Adopt the monotonic common prefix of the last two transcriptions.
    /// Monotonic: only adopt a new prefix when it is at least as long as the
    /// current safetext (prevents flicker when a later transcription disagrees
    /// on already-seen words).
    fn update_stable_prefix(&mut self) {
        if self.text_storage.len() < 2 {
            return;
        }
        let a = &self.text_storage[self.text_storage.len() - 2];
        let b = &self.text_storage[self.text_storage.len() - 1];
        let prefix = common_prefix(a, b);
        if prefix.len() >= self.stable_safetext.len() {
            self.stable_safetext = prefix;
        }
    }

    /// Anchor `fresh` onto the stable safetext via tail-match overlap.
    fn merge(&self, fresh: &[char]) -> Vec<char> {
        match find_tail_match_in_text(&self.stable_safetext, fresh, TAIL_MATCH_LEN) {
            None => {
                // No overlap: stable wins if non-empty, else fresh (cold start).
                if self.stable_safetext.is_empty() {
                    fresh.to_vec()
                } else {
                    self.stable_safetext.clone()
                }
            }
            Some(matching_pos) => {
                let mut out = self.stable_safetext.clone();
                out.extend_from_slice(&fresh[matching_pos..]);
                out
            }
        }
    }
}

/// Coerce a (possibly falsy) raw realtime text to its stripped form.
/// Python: `(fresh_text or "").strip()`.
fn normalize(fresh_text: &str) -> String {
    fresh_text.trim().to_string()
}

/// Longest common prefix of two char slices. Mirrors `os.path.commonprefix`
/// (which, for a 2-element list, is the char-wise longest common prefix).
fn common_prefix(a: &[char], b: &[char]) -> Vec<char> {
    let mut n = 0;
    let max = a.len().min(b.len());
    while n < max && a[n] == b[n] {
        n += 1;
    }
    a[..n].to_vec()
}

/// Return the index in `text2` where the last `length_of_match` chars of `text1`
/// END (the cut point for the fresh suffix), searching `text2` from the END so
/// the most recent occurrence wins. Returns `None` if either string is shorter
/// than `length_of_match` or no occurrence is found.
///
/// Concretely: text1="The quick brown" (last 10 = "uick brown"),
/// text2="The quick brown fox jumps" -> returns Some(15) — the index where the
/// tail match ENDS in text2.
pub fn find_tail_match_in_text(
    text1: &[char],
    text2: &[char],
    length_of_match: usize,
) -> Option<usize> {
    if text1.len().min(text2.len()) < length_of_match {
        return None;
    }
    let target = &text1[text1.len() - length_of_match..];
    scan_windows_from_right(text2, target, length_of_match)
}

/// Return the END index of the RIGHT-MOST window in `text2` equal to `target`.
/// Caller guarantees `text2.len() >= length_of_match` and
/// `target.len() == length_of_match`.
fn scan_windows_from_right(
    text2: &[char],
    target: &[char],
    length_of_match: usize,
) -> Option<usize> {
    // Python: for i in range(len(text2) - L + 1): end = len(text2) - i; window
    // = text2[end-L:end]. i ascends from 0 so `end` descends from len -> the
    // first match found is the right-most window.
    let count = text2.len() - length_of_match + 1;
    for i in 0..count {
        let end = text2.len() - i;
        let window = &text2[end - length_of_match..end];
        if window == target {
            return Some(end);
        }
    }
    None
}

// ============================================================================
// COMMITTED-WATERMARK ACCUMULATOR
// ============================================================================

/// Commit the older portion of the fresh window once it exceeds this many
/// seconds (recorder_service.py `REALTIME_COMMIT_AFTER_SECONDS`). Exposed so the
/// host can tune it; the WinSTT value should be mirrored during the compile loop
/// (it is a module constant in recorder_service.py — re-read it then).
pub const REALTIME_COMMIT_AFTER_SECONDS: f32 = 2.0;

/// Pure text+watermark bookkeeping for the live-preview accumulator. The audio
/// slicing + transcribe calls live in the recorder pipeline (heavy ORT); this
/// type owns ONLY the committed-text string, the frame watermark, the last
/// published text, and the stabilizer, exactly mirroring the recorder_service
/// fields `_realtime_committed_text`, `_realtime_committed_frames`,
/// `_last_realtime_text`, `_realtime_stabilizer`.
#[derive(Debug, Default)]
pub struct RealtimeAccumulator {
    committed_text: String,
    committed_frames: u64,
    last_realtime_text: String,
    stabilizer: RealtimeStabilizer,
}

/// What one publish tick produced. The host emits two events from this (mirrors
/// RealtimeSTT ordering): `Stabilized` (UI-safe monotonic; consumed by the live
/// preview AND the dynamic-silence classifier) then `Update` (raw assembled
/// text; consumed by the noise-break detector).
#[derive(Debug, Clone, PartialEq)]
pub struct RealtimePublish {
    pub stabilized: String,
    pub raw: String,
}

impl RealtimeAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn committed_text(&self) -> &str {
        &self.committed_text
    }
    pub fn committed_frames(&self) -> u64 {
        self.committed_frames
    }
    pub fn last_realtime_text(&self) -> &str {
        &self.last_realtime_text
    }

    /// Empty the committed-text accumulator + watermark.
    ///
    /// `clear_last` also wipes `last_realtime_text` and resets the stabilizer —
    /// done at the START of a fresh recording, but NOT when a recording ends
    /// (the final-text reuse path consumes `last_realtime_text` when
    /// `use_main_model_for_realtime` is on). Mirrors
    /// `_reset_realtime_accumulator(clear_last=)`.
    pub fn reset(&mut self, clear_last: bool) {
        self.committed_text.clear();
        self.committed_frames = 0;
        if clear_last {
            self.last_realtime_text.clear();
            self.stabilizer.reset();
        }
    }

    /// Frames available past the watermark given the current total frame count.
    pub fn fresh_frames(&self, total_frames: u64) -> u64 {
        total_frames.saturating_sub(self.committed_frames)
    }

    /// Number of frames to commit per chunk, from the audio frame rate. Mirrors
    /// `commit_chunk_frames = max(1, int(REALTIME_COMMIT_AFTER_SECONDS * fps))`.
    pub fn commit_chunk_frames(frames_per_second: f32) -> u64 {
        (REALTIME_COMMIT_AFTER_SECONDS * frames_per_second).max(1.0) as u64
    }

    /// Commit the older portion once the fresh window exceeds the threshold.
    ///
    /// `total_frames` is the audio buffer's current frame count; `fps` its
    /// frames-per-second. `transcribe_window(start, end)` returns the
    /// transcribed text for the committed slice, or `None` when the realtime
    /// transcriber is mid-swap (skip without advancing — matches the `None` vs
    /// `""` distinction in `_maybe_append_commit_text`). Returns the (possibly
    /// advanced) committed-frame watermark. Mirrors `_realtime_commit_if_needed`
    /// + `_commit_chunk` + `_append_committed_text`.
    ///
    /// Watermark advances ALWAYS once the threshold is crossed (even on empty
    /// commit text) so the same audio is never re-processed.
    pub fn commit_if_needed<F>(&mut self, total_frames: u64, fps: f32, mut transcribe_window: F) -> u64
    where
        F: FnMut(u64, u64) -> Option<String>,
    {
        let commit_chunk = Self::commit_chunk_frames(fps);
        let fresh = self.fresh_frames(total_frames);
        if fresh <= commit_chunk {
            return self.committed_frames;
        }
        let start = self.committed_frames;
        let end = start + commit_chunk;
        // Transcribe the slice; append only non-empty, non-None text.
        if let Some(text) = transcribe_window(start, end) {
            if !text.trim().is_empty() {
                self.append_committed_text(text.trim());
            }
        }
        // Always advance, even on empty/None output.
        self.committed_frames = end;
        self.committed_frames
    }

    fn append_committed_text(&mut self, commit_text: &str) {
        if self.committed_text.is_empty() {
            self.committed_text.push_str(commit_text);
        } else {
            self.committed_text.push(' ');
            self.committed_text.push_str(commit_text);
        }
    }

    /// Assemble `committed + " " + fresh` (skipping the joiner when either side
    /// is empty). Mirrors `_assemble_realtime_text`.
    pub fn assemble(&self, fresh_text: &str) -> String {
        if self.committed_text.is_empty() {
            return fresh_text.to_string();
        }
        if fresh_text.is_empty() {
            return self.committed_text.clone();
        }
        format!("{} {}", self.committed_text, fresh_text)
    }

    /// Produce the publish payload for the fresh window text: assemble raw text,
    /// run it through the stabilizer, store the stabilized text as the
    /// last-published text (reuse path), and return both. Mirrors
    /// `_realtime_publish_fresh` + `_publish_realtime_update` (minus the IO/event
    /// emission, which the host does with the returned payload).
    pub fn publish_fresh(&mut self, fresh_text: &str) -> RealtimePublish {
        let raw = self.assemble(fresh_text);
        let stabilized = self.stabilizer.update(&raw);
        self.last_realtime_text = stabilized.clone();
        RealtimePublish { stabilized, raw }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    // ---- common_prefix ----
    #[test]
    fn common_prefix_basic() {
        assert_eq!(
            common_prefix(&chars("the quick"), &chars("the quack")),
            chars("the qu")
        );
        assert_eq!(common_prefix(&chars("abc"), &chars("abc")), chars("abc"));
        assert_eq!(common_prefix(&chars("abc"), &chars("xyz")), chars(""));
        assert_eq!(common_prefix(&chars(""), &chars("abc")), chars(""));
    }

    // ---- find_tail_match_in_text ----
    #[test]
    fn tail_match_end_index() {
        // doc example: text1="The quick brown", last 10 = "uick brown";
        // text2="The quick brown fox jumps" -> Some(15).
        let t1 = chars("The quick brown");
        let t2 = chars("The quick brown fox jumps");
        assert_eq!(find_tail_match_in_text(&t1, &t2, TAIL_MATCH_LEN), Some(15));
    }

    #[test]
    fn tail_match_returns_rightmost_occurrence() {
        // "abcabcabca" — searching for tail "0123456789"? Build a case where the
        // target recurs and the RIGHT-MOST wins.
        let t1 = chars("XXXXXrepeat"); // last 10 = "XXXXrepeat"
        // text2 has "XXXXrepeat" twice; expect the END index of the second one.
        let t2 = chars("XXXXrepeat____XXXXrepeat");
        let pos = find_tail_match_in_text(&t1, &t2, TAIL_MATCH_LEN).unwrap();
        assert_eq!(pos, t2.len()); // right-most window ends at the very end
    }

    #[test]
    fn tail_match_none_when_too_short() {
        assert_eq!(find_tail_match_in_text(&chars("short"), &chars("also short"), 10), None);
        assert_eq!(find_tail_match_in_text(&chars("0123456789"), &chars("nope"), 10), None);
    }

    #[test]
    fn tail_match_none_when_absent() {
        let t1 = chars("aaaaaaaaaa"); // last 10 = "aaaaaaaaaa"
        let t2 = chars("bbbbbbbbbbbb");
        assert_eq!(find_tail_match_in_text(&t1, &t2, TAIL_MATCH_LEN), None);
    }

    // ---- stabilizer.update ----
    #[test]
    fn cold_start_returns_fresh() {
        let mut s = RealtimeStabilizer::new();
        // First tick: storage has 1 item, no stable prefix; merge with empty
        // safetext + no tail match -> fresh.
        assert_eq!(s.update("hello world"), "hello world");
    }

    #[test]
    fn monotonic_safetext_grows_and_anchors() {
        let mut s = RealtimeStabilizer::new();
        s.update("the quick brown");
        // Second tick agrees on a long prefix and extends.
        let out = s.update("the quick brown fox jumps");
        // commonprefix("the quick brown", "the quick brown fox jumps") =
        // "the quick brown"; safetext adopts it; tail-match anchors the suffix.
        assert_eq!(out, "the quick brown fox jumps");
        assert_eq!(s.safetext(), "the quick brown");
    }

    #[test]
    fn safetext_never_shrinks_on_rewrite() {
        let mut s = RealtimeStabilizer::new();
        s.update("the quick brown fox");
        s.update("the quick brown fox jumps"); // safetext -> "the quick brown fox"
        let anchor = s.safetext();
        assert_eq!(anchor, "the quick brown fox");
        // Whisper now rewrites an earlier word ("quick" -> "quack"): the new
        // common prefix is shorter, so monotonic safetext does NOT shrink.
        s.update("the quack brown fox jumps over");
        assert_eq!(s.safetext(), "the quick brown fox");
    }

    #[test]
    fn empty_and_whitespace_normalized() {
        let mut s = RealtimeStabilizer::new();
        assert_eq!(s.update("   "), "");
        assert_eq!(s.update("  hi  "), "hi");
    }

    #[test]
    fn reset_clears_state() {
        let mut s = RealtimeStabilizer::new();
        s.update("the quick brown fox");
        s.update("the quick brown fox jumps");
        assert!(!s.safetext().is_empty());
        s.reset();
        assert_eq!(s.safetext(), "");
        // After reset a fresh utterance starts cleanly.
        assert_eq!(s.update("brand new sentence"), "brand new sentence");
    }

    #[test]
    fn unicode_is_character_indexed() {
        // CJK text: char-based slicing must not split multi-byte code points.
        let mut s = RealtimeStabilizer::new();
        s.update("你好世界这是测试一二三"); // 11 chars
        let out = s.update("你好世界这是测试一二三四"); // extends by one char
        // safetext should be the 11-char common prefix; output extends to 12.
        assert_eq!(s.safetext().chars().count(), 11);
        assert_eq!(out.chars().count(), 12);
    }

    // ---- accumulator ----
    #[test]
    fn assemble_joins_with_space() {
        let mut acc = RealtimeAccumulator::new();
        assert_eq!(acc.assemble("fresh"), "fresh"); // no committed yet
        acc.append_committed_text("committed part");
        assert_eq!(acc.assemble("fresh part"), "committed part fresh part");
        assert_eq!(acc.assemble(""), "committed part"); // empty fresh
    }

    #[test]
    fn commit_chunk_frames_floor() {
        // fps small enough that the product < 1 still yields >= 1.
        assert_eq!(RealtimeAccumulator::commit_chunk_frames(0.0), 1);
        // 2.0s * 31.25 fps (512 @ 16k) = 62.5 -> 62 frames.
        assert_eq!(RealtimeAccumulator::commit_chunk_frames(31.25), 62);
    }

    #[test]
    fn commit_advances_watermark_and_appends() {
        let mut acc = RealtimeAccumulator::new();
        let fps = 100.0; // commit_chunk = 200 frames
        // Not enough fresh frames -> no commit, watermark stays 0.
        let wm = acc.commit_if_needed(150, fps, |_s, _e| Some("nope".into()));
        assert_eq!(wm, 0);
        assert_eq!(acc.committed_text(), "");

        // Enough fresh frames (> 200) -> commit one chunk.
        let wm2 = acc.commit_if_needed(500, fps, |s, e| {
            assert_eq!((s, e), (0, 200));
            Some("first chunk".into())
        });
        assert_eq!(wm2, 200);
        assert_eq!(acc.committed_text(), "first chunk");
    }

    #[test]
    fn commit_advances_even_on_empty_or_none() {
        let mut acc = RealtimeAccumulator::new();
        let fps = 100.0; // commit_chunk = 200
        // None (mid-swap): watermark still advances, no text appended.
        let wm = acc.commit_if_needed(500, fps, |_s, _e| None);
        assert_eq!(wm, 200);
        assert_eq!(acc.committed_text(), "");
        // Empty string: still advances, no append.
        let wm2 = acc.commit_if_needed(900, fps, |_s, _e| Some("   ".into()));
        assert_eq!(wm2, 400);
        assert_eq!(acc.committed_text(), "");
    }

    #[test]
    fn publish_fresh_assembles_and_stabilizes() {
        let mut acc = RealtimeAccumulator::new();
        acc.append_committed_text("hello there");
        let p1 = acc.publish_fresh("general");
        assert_eq!(p1.raw, "hello there general");
        // First stabilizer tick (cold) returns the assembled text verbatim.
        assert_eq!(p1.stabilized, "hello there general");
        assert_eq!(acc.last_realtime_text(), "hello there general");
    }

    #[test]
    fn reset_clear_last_wipes_stabilizer_and_committed() {
        let mut acc = RealtimeAccumulator::new();
        acc.append_committed_text("old committed");
        acc.publish_fresh("tail");
        // reset(false): keep last_realtime_text + stabilizer (end-of-recording).
        acc.reset(false);
        assert_eq!(acc.committed_text(), "");
        assert_eq!(acc.committed_frames(), 0);
        assert_eq!(acc.last_realtime_text(), "old committed tail");

        // reset(true): fresh recording -> everything cleared.
        acc.append_committed_text("again");
        acc.reset(true);
        assert_eq!(acc.last_realtime_text(), "");
        assert_eq!(acc.committed_text(), "");
    }
}

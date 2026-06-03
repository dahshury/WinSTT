import type { SpeakerSegment } from "../model/transcription";

const WHITESPACE_SPLIT = /\s+/;

export interface SpeakerTextChunk {
  speaker: number;
  text: string;
}

/**
 * Split text into per-speaker chunks weighted by segment duration.
 *
 * The diarizer emits segments in seconds; the transcriber gives us the full
 * sentence as one string with no per-word timing. This approximates by splitting
 * at word boundaries proportional to each segment's duration share.
 */
export function splitTextBySpeaker(
  text: string,
  segments: SpeakerSegment[],
): SpeakerTextChunk[] {
  const trimmed = text.trim();
  if (trimmed.length === 0 || segments.length === 0) {
    return [{ speaker: -1, text }];
  }

  const totalSpeech = segments.reduce(
    (acc, s) => acc + Math.max(0, s.end - s.start),
    0,
  );
  if (totalSpeech <= 0) {
    return [{ speaker: segments[0]?.speaker ?? -1, text }];
  }

  const words = trimmed.split(WHITESPACE_SPLIT);
  if (words.length <= 1) {
    return [{ speaker: segments[0]?.speaker ?? -1, text }];
  }

  const chunks: SpeakerTextChunk[] = [];
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) {
      continue;
    }
    const share = Math.max(0, seg.end - seg.start) / totalSpeech;
    const wordCount =
      i === segments.length - 1
        ? words.length - cursor
        : Math.max(1, Math.round(share * words.length));
    const end = Math.min(words.length, cursor + wordCount);
    if (end > cursor) {
      chunks.push({
        speaker: seg.speaker,
        text: words.slice(cursor, end).join(" "),
      });
      cursor = end;
    }
  }
  if (cursor < words.length) {
    const lastSpeaker = segments.at(-1)?.speaker ?? -1;
    chunks.push({ speaker: lastSpeaker, text: words.slice(cursor).join(" ") });
  }
  return chunks;
}

export function speakerCount(segments: SpeakerSegment[] | undefined): number {
  return segments ? new Set(segments.map((s) => s.speaker)).size : 0;
}

/** Speaker owning the most speech time in an item, or -1 if undiarized. */
export function dominantSpeaker(
  segments: SpeakerSegment[] | undefined,
): number {
  if (!segments || segments.length === 0) {
    return -1;
  }
  const totals = new Map<number, number>();
  for (const s of segments) {
    totals.set(
      s.speaker,
      (totals.get(s.speaker) ?? 0) + Math.max(0, s.end - s.start),
    );
  }
  let best = -1;
  let bestDur = -1;
  for (const [spk, dur] of totals) {
    if (dur > bestDur) {
      bestDur = dur;
      best = spk;
    }
  }
  return best;
}

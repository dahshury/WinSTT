// Dedicated worker that computes the two diff/tokenize-heavy History stats off
// the main thread: `aggregate` (a word-level LCS diff per AI-touched entry) and
// `computeVoiceProfile` (Unicode tokenization of every transcript plus more
// diffs). These were the only stats heavy enough to jank a fresh open with a
// large history; the rest (usage/streak/heatmap) are cheap O(n) passes that
// stay on the main thread. The worker keeps its own per-entry diff cache (keyed
// by id), so successive messages only diff entries it hasn't seen.

import type { AggregateStats } from "./word-stats";
import { aggregate } from "./word-stats";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import type { VoiceProfileStats } from "./voice-profile";
import { computeVoiceProfile } from "./voice-profile";

export interface HistoryStatsRequest {
	entries: TranscriptionHistoryEntry[];
	/** Echoed back so the main thread can drop responses to superseded inputs. */
	seq: number;
}

export interface HistoryStatsResponse {
	seq: number;
	stats: AggregateStats;
	voiceProfile: VoiceProfileStats;
}

// The project ships the DOM lib (not WebWorker), so type only the slice of the
// dedicated-worker global we touch and cast `self` to it — avoids a lib switch.
interface WorkerScope {
	onmessage: ((event: MessageEvent<HistoryStatsRequest>) => void) | null;
	postMessage(message: HistoryStatsResponse): void;
}

const ctx = self as unknown as WorkerScope;

ctx.onmessage = (event) => {
	const { entries, seq } = event.data;
	ctx.postMessage({
		seq,
		stats: aggregate(entries),
		voiceProfile: computeVoiceProfile(entries),
	});
};

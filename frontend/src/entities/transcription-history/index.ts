export {
	type AggregateStats,
	aggregate,
	buildHeatmap,
	type DayBucket,
	filterEntriesByDateRange,
	formatDuration,
	formatWpm,
	intensityLevel,
	startOfLocalDay,
	sumWordsByDay,
	toDayKey,
	wordsPerMinute,
} from "./lib/word-stats";
export {
	type TranscriptionHistoryEntry,
	useTranscriptionHistoryStore,
} from "./model/history-store";

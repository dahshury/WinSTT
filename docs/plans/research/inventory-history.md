# Transcription History Feature Inventory

The Transcription History area of WinSTT is a multi-tab interface displaying all saved transcriptions with aggregate statistics, per-day activity heatmap, granular date-range filtering, and playback with word-by-word highlight sync. History entries persist via electron-store (JSON); WAV recordings save to userData/recordings/ with optional retention policy.

## Overall Stats Panel (HistorySummary)

Four stat tiles aggregate filtered history entries.

### Total Transcriptions
- Count of transcription entries
- Format: Localized number (e.g., '1,250')
- Default: 0
- Setting key: Not configurable

### Total Words
- Sum of entry.wordCount across filtered entries
- Format: Localized number
- Default: 0
- Calculation: Sum of all entry.wordCount

### Speaking Time
- Total duration of filtered transcriptions
- Format: 'Xh YYm ZZs', '<1s' for < 1000 ms
- Calculation: formatDuration(totalDurationMs)

### Overall WPM
- Aggregate speaking rate
- Format: Decimal or '—' if duration < 500 ms
- Calculation: (totalWords * 60,000) / totalDurationMs

## Daily Activity Heatmap (ActivityHeatmap)

GitHub-style calendar heatmap over 365-day rolling window.

### Metric Selector
- Switch color intensity by: transcriptions, words, or wpm
- Label: 'Metric'
- Default: 'transcriptions'
- Storage: Component state (not persisted)

### Calendar System Selector
- Label: 'Calendar'
- Options: gregorian, hijri
- Default: gregorian
- Storage: Component state (not persisted)

### Heatmap Grid
- Window: 365 days from today (local time, not UTC)
- Colors: 5-level intensity (bg-teal/20 to bg-teal)
- Cell size: 2.5 rem
- Weeks start on Sunday
- Disabled cells: Days with zero activity

### Date Range & Presets
- Manual selection: Click to start/end range
- 9 preset chips: Today, Yesterday, Last 7/30 days, This/Last month, Month to date, Year to date, Last year
- Range display: Shows formatted dates + Clear button when active
- Not persisted; session-scoped

## Transcription History Table (HistoryTable)

Scrollable list sorted newest-first.

### Entry Row Layout
1. Play button (conditional): Appears only if entry.audioFilePath exists
   - Play icon when idle, Pause when playing
   - Spinner while loading, disabled during load

2. Transcribed text: Full entry.text (post-LLM if applicable)
   - Pre-wrapped whitespace preservation
   - With word timings: split into spans
   - Playing word highlighted with bg-accent/25

3. Action buttons:
   - Copy: Copies entry.text, shows check 1600 ms
   - Delete: Removes entry + WAV (async IPC)

4. Metadata strip: Time, Words, Duration, WPM (optional), Model (optional)

### Context Menu
Right-click shows:
- Copy (entry.text)
- Copy original (entry.originalText, disabled if empty)

### Playback
- Lazy load: Audio + word timings fetched on first play
- Output routing: Via settings.general.outputDeviceId
- Word highlighting: Karaoke effect with rAF loop
- Progress: Highlight sweep IS the progress (no scrubber)

### Virtualization
- Threshold: < 50 entries render directly; >= 50 use virtua VList
- Height estimate: 104 px (auto-corrects)
- Max container: 460 px (scrolls longer)

## History Limits & Retention Panel

### Max History Entries
- Label: 'Max History Entries'
- Control: Number stepper
- Range: 10–10,000
- Default: 1,000
- Setting key: settings.general.historyMaxEntries
- Behavior: Auto-trims oldest when exceeded

### Recording Retention
- Label: 'Recording Retention'
- Options: never (Keep forever), cap (When over limit), days3, weeks2, months3
- Default: cap
- Setting key: settings.general.recordingRetention
- Cleanup: App startup + setting change + hourly sweep
- Gotcha: 'never' means Keep forever, not don't save

### Clear All History
- Button in History Table header
- Opens confirmation dialog
- Permanent deletion; no undo

## Data Storage

### Electron Main (electron-store)
- File: userData/history.json
- Max cap: 10,000 entries
- Entry fields: id, timestamp, text, wordCount, durationMs, audioFilePath?, originalText?, llmModel?

### IPC Channels
- HISTORY_GET_ALL: Fetch entries
- HISTORY_ADDED: Subscription
- HISTORY_DELETED: Subscription
- HISTORY_LOAD_AUDIO(entryId): WAV data URI (lazy)
- HISTORY_ALIGN_AUDIO(entryId): Per-word timing
- HISTORY_DELETE(entryId): Delete entry
- HISTORY_CLEAR: Wipe all

### Renderer Store (Zustand)
- Hook: useTranscriptionHistoryStore()
- State: entries[], isLoaded, setAll(), addEntry(), removeEntry(), clear()
- Sync: useTranscriptionHistorySync() subscribes to IPC events

### WAV Recordings
- Directory: userData/recordings/
- Format: 16-bit PCM/ADPCM, 16 kHz mono
- Cleanup: Retention policy + hourly server sweep

### Word Alignment
- Server: WordAligner in src/recorder/infrastructure/word_aligner.py
- Model: Tiny timestamped-Whisper (~40 MB, CPU)
- Algorithm: Cross-attention DTW; fallback to Silero VAD + heuristic
- Caching: NOT persisted; recomputed per play
- Accuracy: Boundaries remapped via difflib SequenceMatcher

## Conditional Visibility

Playback button: Visible when entry.audioFilePath exists; never for pre-audio-save/cloud-STT/deleted
Copy original menu: Visible when entry.originalText exists and non-empty
Date range bar: Visible when manual range active
WPM stat: Visible when duration >= 500 ms

## Performance

- Max entries: 10,000
- Virtualize threshold: 50
- Heatmap: 365-day window
- Row height: 104 px estimate
- Max table: 460 px height
- Word alignment: ~100-200 ms per clip

## Key Gotchas

1. Audio disabled: Play button never appears if save_wav false
2. Cloud STT: No audio saved to disk
3. Retention 'never': Means Keep forever, not don't save
4. Word alignment fallback: No highlighting on error
5. Heatmap scaling: Relative to 365-day max, not absolute
6. Date range: Local-time boundaries, not UTC
7. Deletion: Permanent; no undo
8. Playback device: Falls back to system default if unavailable
9. Original text: Missing if LLM disabled during recording

## Related Settings

- settings.general.historyMaxEntries (10-10,000)
- settings.general.recordingRetention (never/cap/days3/weeks2/months3)
- settings.general.outputDeviceId (playback routing)
- settings.llm.dictation.enabled (controls originalText)


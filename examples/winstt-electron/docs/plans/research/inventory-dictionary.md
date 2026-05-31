# Dictionary Tab — Feature Inventory

The Dictionary tab allows users to teach the Whisper model custom vocabulary and configure spelling correction behavior. It supports two modes: vocabulary words (names, jargon, brands) that bias the LLM toward preferred spellings, and replacement pairs (deterministic mis-transcription fixes) applied after LLM cleanup.

## Dictionary Entry (Vocab Words & Replacements)

**What it does:**
Stores user-defined vocabulary. Each entry can be a vocabulary word only or a replacement pair (term to replacement, applied deterministically after LLM cleanup).

**Storage shape:**
- id: string UUID
- term: string (required, non-empty)
- replacement: string (optional)

**Entry mode behavior:**

| Mode | Has replacement? | Effect | Timing |
|------|---|---|---|
| Vocab only | No | Folded into LLM prompt to bias toward preferred spelling | During transcription + LLM cleanup |
| Replacement pair | Yes | Case-insensitive whole-word string replace after LLM cleanup | After LLM cleanup (safety net) |

**Setting key:** settings.dictionary

**Validation:**
- term: required, non-empty after trim
- replacement: optional, trimmed if present

**Non-obvious behavior:**
- Vocabulary words and replacement pairs coexist in same list. Presence/absence of replacement determines behavior.
- Replacement pairs fire AFTER LLM cleanup, so LLM sees original mis-transcription and can apply context-aware fixes.

## Auto-Add Suggestions (LLM-Learned Proper Nouns)

**What it does:**
Shows dynamic suggestion strip of proper nouns LLM cleanup pipeline has detected. Users can Accept to add to dictionary, or Dismiss to discard suggestion for this session.

**Visibility:**
Only appears when there are pending suggestions; auto-hides when empty.

**Suggestions source:**
Subscribed to LLM_LEARNED_PROPER_NOUNS IPC broadcast. Filtered case-insensitive against existing dictionary entries.

**Behavior:**

| Action | Effect | Persistence |
|---|---|---|
| Accept | Noun added as vocab-only entry. Pill removed. | Persisted immediately. |
| Dismiss | Pill removed. | NOT persisted; reappears if LLM re-suggests. |

**Suggestion list limits:**
- Max 20 suggestions (prevent chatty LLM from filling strip)
- Most-recent at start; older scroll left
- Case-insensitive dedup

**Non-obvious behavior:**
- Kept ONLY in component-local React state. Accepting writes to store; declining forgets from list.
- Refreshing settings panel clears pending suggestions (ephemeral UI).
- Component re-filters when existingTerms prop changes.

**Setting key:**
No persistent setting; driven by IPC events and local state.

## Dictionary Table (Add, Remove, Clear All)

**What it does:**
Displays dictionary entries in table. Provides controls to add new entries, delete individual entries, and bulk-clear.

**Table display:**

| Column | Contains | Notes |
|---|---|---|
| Term | Vocabulary word or replacement-pair source term | Read-only; edit via delete-and-re-add |
| Action | Delete button per row | Hover for tooltip |

**Empty state:**
"No dictionary entries yet" placeholder.

**Add entry form:**
- Term field: text input, case-sensitive. Placeholder "Add a name, brand, or term..."
- Validation: required, non-empty after trim
- Error display: inline per-field (FormControl)
- Add button: disabled while term empty/whitespace-only
- On submit: validates via addDictionaryEntrySchema (Zod trim + min 1). Success adds as vocab-only; form clears. Fail shows error.

**Delete individual entry:**
Click delete icon on row; immediately removes; no confirmation per entry.

**Clear all:**
- Button "Delete All" (disabled when 0 entries)
- Triggers confirmation dialog
- Confirm wipes entire dictionary array

**Setting key:** settings.dictionary via updateDictionary() store action.

**Non-obvious behavior:**
- Table UI does NOT display or allow editing replacement field
- Entries rendered in array order; no sorting/drag
- Term field case-sensitive; no auto-norm
- Each entry gets unique UUID at store level

## Fuzzy Correction Threshold (wordCorrectionThreshold)

**What it does:**
Tunes maximum fuzzy-match score the server-side deterministic corrector accepts when snapping phonetically-close words to dictionary vocab. Fires BEFORE LLM cleanup.

**Control:**
- Label: "Correction strictness"
- Caption: Maximum fuzzy-match score the server-side corrector will accept. Lower = stricter.
- Tooltip: The deterministic corrector runs on the server right after transcription and BEFORE the LLM cleanup. Anything it misses still gets a second pass through the LLM modifiers.
- UI: NumberStepper (spinner with arrows + text input)
- Range: 0.0 to 1.0, step 0.02
- Default: 0.18 (reference Whisper/Wispr default)
- Visibility: Always visible

**How it works:**
- Lower (0.0-0.3): stricter, fewer false positives
- Higher (0.5-1.0): permissive, snaps aggressively
- 0.18: sweet spot

**Setting key:** settings.general.wordCorrectionThreshold

**Persistence:**
- Persisted as number (0.0-1.0)
- On load: .catch(0.18) provides fallback
- Changes apply immediately next transcription

**Non-obvious behavior:**
- Applies only to server-side deterministic fuzzy matcher
- When LLM enabled, LLM runs AFTER this pass
- When LLM disabled, this is only line of defense

## Related Settings

**Enable/Disable LLM Dictation**
- Where: Settings > LLM > Dictation toggle
- Effect: When LLM off, vocab via fuzzy matching + server post-processor
- Setting key: settings.llm.dictation.enabled

**Custom Filler Words**
- Where: Settings > General
- Related: Both are post-transcription cleanup
- Setting key: settings.general.customFillerWords

## Summary: Controls Documented

1. Term Input Field — text input, case-sensitive, required non-empty
2. Add Button — submit form, validates Zod schema, disabled when empty
3. Delete Row Button — immediate removal per entry, no confirmation
4. Delete All Button — confirmation dialog required, wipes entire dictionary
5. Auto-Add Suggestions Strip — IPC-driven, max 20 pills, Accept/Dismiss, local state only
6. Fuzzy Correction Threshold Spinner — 0.0 to 1.0 range, default 0.18, server-side deterministic matching

# Snippets Tab Inventory

The **Snippets** feature enables text expansion: users define a short spoken trigger phrase that automatically expands into longer text on transcription. Matching is fuzzy so minor transcription variations still match. Snippets are persisted as an array in the main settings store.

---

## Trigger Field

**What it does:** Accepts the short spoken phrase that activates the snippet expansion. Matched fuzzily against transcribed text.

**Options/Range:** Text input, no length constraints (practically 1-5 words).

**Default:** Empty on first add (user must type).

**Conditional Visibility:** Always visible; required to submit the add form.

**Setting Key:** snippets[].trigger (OpenAPI SnippetEntry string).

**Validation & Gotchas:**
- Zod schema addSnippetEntrySchema.trigger requires .trim().min(1).
- Whitespace stripped before validation.
- Form disables Add button unless both trigger and expansion are non-empty after trim.
- Error message if user tries to add with blank trigger.

---

## Expansion Field

**What it does:** The target text replacing the trigger. Arbitrary length.

**Options/Range:** Text input, no length constraints.

**Default:** Empty on first add (user must type).

**Conditional Visibility:** Always visible; required to submit the add form.

**Setting Key:** snippets[].expansion (OpenAPI SnippetEntry string).

**Validation & Gotchas:**
- Zod schema addSnippetEntrySchema.expansion requires .trim().min(1).
- Whitespace stripped before validation.
- Form disables Add button unless both fields are non-empty after trim.
- Error message if user tries to add with blank expansion.
- No HTML escaping; raw text preserved as-is.

---

## Add Button

**What it does:** Submits form to create new snippet entry. Clears inputs and adds entry with generated ID.

**Options/Range:** Binary (enabled/disabled).

**Default:** Disabled until both fields contain non-whitespace text.

**Conditional Visibility:** Always visible.

**Setting Key:** N/A (UI control only).

**Validation & Gotchas:**
- Button disabled when both inputs empty after trim.
- Validation runs via safeParse() on submit.
- On validation failure, field errors appear.
- On success, generateId() creates unique ID.
- Styled with bg-accent and hover:bg-accent-hover.

---

## Snippets Table

**What it does:** Displays all persisted entries in two-column table with delete button per row.

**Options/Range:** N/A (read-only display).

**Default:** Empty array initially.

**Conditional Visibility:** Always visible.

**Setting Key:** snippets (array of SnippetEntry objects).

**Validation & Gotchas:**
- Trigger column (left, ~1/3 width) styled text-purple.
- Expansion column (right, ~2/3 width) styled text-foreground.
- Uses @base-ui/react components: Table, TableBody, TableRow, TableCell, etc.
- Container has rounded border.
- Rows keyed by entry.id.
- Table body lifts +1 from panel baseline.

---

## Delete Button (Per Row)

**What it does:** Removes single snippet entry via trash icon.

**Options/Range:** Binary (one per row).

**Default:** Enabled unless table is empty.

**Conditional Visibility:** Visible if entries exist.

**Setting Key:** N/A (filters updateSnippets()).

**Validation & Gotchas:**
- Wrapped in Tooltip.
- Delete02Icon from @hugeicons/core-free-icons (14px).
- Styled bg-transparent with hover:bg-error-dim and text-error.
- Deletion immediate; no per-row confirmation.

---

## Clear All Button

**What it does:** Removes all entries at once after confirmation.

**Options/Range:** Binary (disabled if table is empty).

**Default:** Disabled when zero entries; enabled with 1+ snippets.

**Conditional Visibility:** Conditional on onClearAll prop (always provided).

**Setting Key:** N/A (calls updateSnippets([]) after confirmation).

**Validation & Gotchas:**
- Styled with error colors: border-error, text-error, hover:bg-error-dim.
- Dialog title: Delete All Snippets?
- Dialog description: All snippets will be permanently removed.
- No undo after confirmation.
- Styled smaller than Add button.

---

## Data Persistence

**Setting Key (full path):** settings.snippets (array of SnippetEntry).

**Schema:** snippets: z.array(snippetEntrySchema).default([])

**Persisted Shape:** { id: string; trigger: string; expansion: string; }

**Default Value:** Empty array [] on first run.

**Wire Format:** Persisted to settings.json via electron-store. Transmitted over IPC.

**Migration:** No migration logic; backward-compatible.

---

## Implementation Details

**Component Hierarchy:**
- SnippetsSettingsPanel (entry point; store integration)
  - SnippetsTable (form and table rendering)
    - Add form (inputs and submit)
    - Results table
    - Clear All button and confirmation dialog

**Store Integration:**
- useSettingsStore reads persisted array.
- useSettingsStore persists changes via IPC.
- All mutations are array-level.

**Localization (i18n):**
- Namespace: snippets in frontend/messages/en.json.
- Keys: title, description, trigger, expansion, emptyState, clearTitle, clearDescription.

**Styling:**
- Tailwind v4 and @base-ui/react.
- 2-column form grid; table with borders.
- Accent for Add; error colors for Clear All.

---

## Non-Obvious Behavior & Gotchas

1. **Fuzzy Matching:** Server-side fuzzy logic. Frontend stores plaintext only.

2. **Trim on Validation:** Zod applies .trim() on safeParse().

3. **No Deduplication:** UI allows duplicate triggers; first match wins.

4. **Order Preservation:** Matched in array order (oldest first).

5. **Empty State:** Shows empty message when no snippets.

6. **Form State:** Inputs are independent useState; cleared on success only.

7. **Error Clearing:** Errors auto-clear on field edit.

8. **Accessibility:** Delete buttons have aria-label. Fields labeled via FormControl.

---

## Summary of Controls Documented

1. **Trigger Field** — Short phrase; fuzzy-matched; required.
2. **Expansion Field** — Replacement text; required.
3. **Add Button** — Form submit; generates ID; disabled when empty.
4. **Snippets Table** — Read-only array display with empty state.
5. **Delete Button (Per Row)** — Immediate removal; one per row.
6. **Clear All Button** — Removes all after confirmation.
7. **Setting Key** — snippets: SnippetEntry[]; default empty; persisted via IPC.
8. **Validation & i18n** — Zod schemas, trim on parse, 9 i18n keys.

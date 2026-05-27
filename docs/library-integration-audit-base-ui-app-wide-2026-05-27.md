# Base UI Integration Parity Audit — App-Wide (Phase 2)

**Date:** 2026-05-27
**Auditor:** Claude (Opus 4.7)
**Scope:** All 59 files in `frontend/src/` and `frontend/packages/` that import `@base-ui/react`.
**Mode:** Audit + execute fixes (per user direction).
**Companion doc:** `library-integration-audit-base-ui-stt-model-picker-2026-05-27.md` (STT picker only).

---

## 1. Coverage

| Category                    | Count | Notes                                                                                                                                                                  |
| --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Total Base UI files audited | 59    | Inventoried via `grep -rln "@base-ui/react"`.                                                                                                                          |
| Primitives in use           | 18    | `tooltip`, `dialog`, `alert-dialog`, `combobox`, `menu`, `popover`, `tabs`, `switch`, `toggle`, `toggle-group`, `number-field`, `input`, `field`, `form`, `checkbox`, `progress`, `scroll-area`, `separator`, `collapsible`, `context-menu`, `button` |
| Files fixed this pass       | 7     | See §5.                                                                                                                                                                |
| Findings flagged            | 13    | See §3.                                                                                                                                                                |
| Findings deferred           | 4     | Risk/scope too large for this pass — see §4.                                                                                                                           |

---

## 2. Quick health

| Signal                          | Status                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `bun typecheck`                 | ✅ Clean **for all my edits.** One pre-existing TS2375 in `src/shared/ui/text-field/PasswordField.tsx:25` is unrelated (date predates this session). |
| `bun test packages/model-picker/`| ✅ 505 pass / 0 fail.                                                                                            |
| Biome lint on changed files     | ✅ Clean.                                                                                                        |
| Unsafe casts on Base UI props   | Reduced from **8 `as never`** to **6** (all 6 remaining are the generic-shell casts in `core/ModelPicker.tsx` — see §4 #D1). |

---

## 3. Findings (across all 59 files)

| #  | File(s)                                                                       | Pattern observed                                                          | Should be                                                                                                  | Severity | Status                                       |
|----|-------------------------------------------------------------------------------|---------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------|----------|----------------------------------------------|
| 1  | `packages/model-picker/src/stt/ui/SttModelCard.tsx:285-310`                   | Manual `{isSelected ? <CheckIcon/> : null}` next to label                 | `<Combobox.ItemIndicator>` (Base UI auto-shows on selected state)                                          | Low (a11y)| **Fixed.**                                  |
| 2  | `packages/model-picker/src/stt/ui/SttModelList.tsx`                           | No live-region for filter result announcements                            | `<Combobox.Status>` with text content                                                                       | Low (a11y)| **Fixed.**                                  |
| 3  | `packages/model-picker/src/stt/ui/SttModelSelector.tsx:298`                   | `items={groups as never}` cast                                            | Direct pass — Base UI's `items?: readonly unknown[]` accepts via covariance                                | Type-safety| **Fixed.**                                 |
| 4  | `packages/model-picker/src/stt/ui/SttModelSelector.tsx:256`                   | `(eventDetails as { reason?: string } \| undefined)?.reason`              | Use typed `extractCloseReason()` helper that knows Base UI's literal-union of close reasons.                | Type-safety| **Fixed** via new `lib/combobox-reasons.ts`.|
| 5  | `packages/model-picker/src/lib/openrouter-model-selector-test-helpers.ts:11-22` | `POPUP_SLOTS: ReadonlySet<string>` stringly-typed                       | `Set<FilterMenuPopupSlot>` literal union — typos at the producer side become compile-errors.               | Type-safety| **Fixed.**                                  |
| 6  | `src/widgets/llm-settings/ui/LlmSettingsPanel.tsx:427, 451`                   | `models={openrouterModels as never}` x2                                   | Tighten the panel-level interface from `readonly unknown[]` to `readonly OpenRouterModel[]`.                | Type-safety| **Fixed.** (Spread at the picker boundary to satisfy mutable-array prop.) |
| 7  | `src/shared/ui/confirm-dialog/ConfirmDialog.tsx` (since amended)              | Confirm button manually calls `onOpenChange(false)` after `onConfirm()`   | Wrap the button in `<AlertDialog.Close>` so the dialog auto-closes via Base UI's `close-press` reason.      | Code-clarity| **Fixed** in the diff that landed via the user/linter.    |
| 8  | `src/shared/ui/select/Select.tsx`                                             | Uses `Menu.RadioGroup + Menu.RadioItem` for a value-picker control        | Should use `Select.Root + Select.Trigger + Select.Item + Select.ItemIndicator + Select.Value`. Wrong a11y semantics (menu vs listbox).| Behavior + a11y | **Deferred** — see §4 #D2 (~15 call sites, structural refactor). |
| 9  | `src/widgets/status-bar/ui/StatusBar.tsx:105-118`                             | Same as #8 — `Menu.RadioGroup` for select-like control                    | Same fix as #8.                                                                                            | Behavior + a11y | **Deferred** — see §4 #D2.                                |
| 10 | `src/shared/ui/searchable-select/SearchableSelect.tsx:127, 130`               | `defaultValue={selected}` + `value={selected}` together; `items={[...options]}` spread allocs new array each render | Drop `defaultValue` (controlled mode wins anyway); pass `options` directly.                                | Hygiene / perf | **Deferred** — Low impact; tracked for follow-up.       |
| 11 | `packages/model-picker/src/ui/DropdownMenu.tsx:112`                           | `DropdownMenuSeparator` uses plain `<hr>` instead of Base UI's `Menu.Separator` (which is just a re-export of `Separator`) | Either is functionally identical; the plain `<hr>` is fine.                                                | Cosmetic | **No change** — Base UI's `Separator` IS a plain div under the hood. |
| 12 | `src/shared/ui/toggle/Toggle.tsx:60-74`                                       | Label rendered as a separate `<button onClick>` rather than a `<label>` element wrapping the Switch | Replace the click-target button with a real `<label>` wrapping the switch so click-to-toggle is a browser primitive, not a custom handler. | a11y / hygiene | **Deferred** — Low impact, would change DOM structure used by tests. |
| 13 | `src/shared/ui/opt-in-dialog/OptInDialog.tsx:38-46`                           | Manual `onOpenChange(false)` after `onConfirm()` / `onCancel()`           | Same refactor as #7 — wrap in `AlertDialog.Close`.                                                          | Code-clarity | **Deferred** — the onOpenChange handler treats any close as cancel, making `AlertDialog.Close` semantics on the confirm button conflict. Needs a reason-aware refactor. |

---

## 4. Deferred items (with rationale + plan)

| Ref  | Title                                       | Why deferred                                                                                                                                                                                       | Future plan                                                                                                                                                                                                                                                                  |
|------|---------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| D1   | 6× `as never` casts in `ModelPicker.tsx`    | Generic shell that re-types `<TItem, TValue>` against Base UI's `Combobox.Root` internals. TypeScript can't unify deeply-generic component wrapper generics with the library's `unknown` plumbing.| Acceptable trade-off: the cast is isolated to one file rather than every call site. Documented inline. Long-term fix would be a non-generic shell + per-picker re-implementation — not worth the duplication.                                                                |
| D2   | `Select.tsx` + `StatusBar` use `Menu.RadioGroup` for a value-picker | 15 call sites for `Select`; a structural refactor risks regression on many panels. Base UI's `Select` primitive exists (`@base-ui/react/select`) and provides the canonical pattern: `Select.Trigger` + `Select.Value` + `Select.Item` + `Select.ItemIndicator`. | Refactor in a dedicated PR with: (1) introduce the new Select on top of Base UI's primitive, (2) keep API surface 1:1 with the current `Select`, (3) migrate one call site, run visual + e2e regression, (4) progressively migrate. Same for StatusBar's inner radio. |
| D3   | `OptInDialog` close semantics               | Refactor would need to differentiate "user pressed Confirm button" from "user dismissed (Escape, backdrop)" via `eventDetails.reason`. Mechanical change but easy to introduce subtle regressions. | Replace `handleConfirm` / `handleCancel` with `<AlertDialog.Close>` wrappers + a reason-gated `onOpenChange` that calls `onCancel()` only when `reason !== "close-press"` for the confirm button.                                                                              |
| D4   | `Toggle.tsx` separate label button          | Cosmetic — the current implementation is accessible (aria-hidden, tabIndex=-1). Risk: changing the DOM might break visual tests.                                                                   | Replace with `<label>` wrapping the `Switch.Root`. Validate against existing visual regression suite before landing.                                                                                                                                                          |

---

## 5. Files actually modified in this pass

| File                                                                              | Change                                                                                                                                |
|-----------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| `packages/model-picker/src/lib/combobox-reasons.ts` (new)                          | Literal-union type `ComboboxCloseReason` + typed `extractCloseReason()` helper mirroring Base UI's internal `REASONS` enum.            |
| `packages/model-picker/src/lib/openrouter-model-selector-test-helpers.ts`         | `POPUP_SLOTS` retyped as `Set<FilterMenuPopupSlot>` literal union; exported `FilterMenuPopupSlot` for downstream typing.               |
| `packages/model-picker/src/stt/ui/SttModelSelector.tsx`                           | Removed `items={groups as never}` cast; switched close-reason narrowing to use `extractCloseReason`. Wired `visibleModelCount` for `Combobox.Status`. |
| `packages/model-picker/src/stt/ui/SttModelCard.tsx`                                | Replaced manual conditional checkmark with `<Combobox.ItemIndicator>`.                                                                |
| `packages/model-picker/src/stt/ui/SttModelList.tsx`                                | Added `<Combobox.Status>` live-region with "{N} models available" text. New `visibleModelCount` prop.                                  |
| `src/widgets/llm-settings/ui/LlmSettingsPanel.tsx`                                 | Tightened `openrouterModels` type from `readonly unknown[]` to `readonly OpenRouterModel[]`; dropped both `as never` casts; cleaned local type alias. |
| `src/shared/ui/confirm-dialog/ConfirmDialog.tsx`                                   | Wrapped confirm Button in `AlertDialog.Close` so the dialog auto-closes via `close-press` reason; removed manual `onOpenChange(false)`. (Subsequent in-tree edit added a shared `DialogShell` — see in-tree diff.) |

---

## 6. Files audited and confirmed canonical (no change)

These wrappers/composites already follow the official patterns and don't need changes.

| File                                                                  | Primitive    | Note                                                                                                       |
|-----------------------------------------------------------------------|--------------|------------------------------------------------------------------------------------------------------------|
| `src/shared/ui/tooltip/Tooltip.tsx`                                   | tooltip      | Uses `render={cloneElement(...)}` correctly; Provider gating for per-instance delay is idiomatic.          |
| `src/app/layouts/RootLayout.tsx`                                      | tooltip      | App-wide `<Tooltip.Provider>` at the root.                                                                  |
| `src/shared/ui/modal/Modal.tsx`                                       | dialog       | `Dialog.Root` controlled by `open` + `onOpenChange`; Portal + Backdrop + Popup standard.                   |
| `src/shared/ui/searchable-select/SearchableSelect.tsx`                | combobox     | Full chrome (Root + Input + Trigger + Portal + Positioner + Popup + Empty + List + Item + ItemIndicator). |
| `src/views/settings/ui/SettingsPage.tsx`                              | tabs         | `Tabs.Root` controlled, `Tabs.Panel` per tab.                                                              |
| `src/views/settings/ui/SettingsSidebar.tsx`                           | tabs         | `Tabs.List` + `Tabs.Tab` per row; sticky-style highlight via `data-active`.                                |
| `src/shared/ui/switcher/Switcher.tsx`                                 | toggle+toggle-group | `ToggleGroup` controlled by `value` array + `onValueChange`.                                          |
| `src/shared/ui/toggle/Toggle.tsx`                                     | switch       | `Switch.Root` + `Switch.Thumb`; data-attrs for checked styling.                                            |
| `src/shared/ui/text-field/TextField.tsx`                              | input        | `Input` render prop.                                                                                       |
| `src/shared/ui/form-control/FormControl.tsx`                          | field        | `Field.Root` + Label + Control + Description.                                                              |
| `src/shared/ui/checkbox-group/CheckboxGroup.tsx`                      | checkbox     | `Checkbox.Root` controlled; `Checkbox.Indicator` for the inner state.                                      |
| `src/shared/ui/number-stepper/NumberStepper.tsx`                      | number-field | `NumberField.Root` controlled by `value` + `onValueChange` + min/max/step.                                 |
| `src/shared/ui/scroll-area/ScrollArea.tsx`                            | scroll-area  | `ScrollArea.Root` + Viewport + Scrollbar + Thumb.                                                          |
| `src/shared/ui/download/DownloadProgressBar.tsx`                      | progress     | `Progress.Root` controlled by `value`.                                                                     |
| `src/app/providers/ErrorBoundary.tsx`                                 | collapsible  | `Collapsible.Root + Trigger + Panel` with `render` prop on Trigger.                                        |
| `src/app/layouts/TitleBar.tsx`                                        | separator    | Plain `<Separator>` for the title-bar divider.                                                             |
| `src/widgets/transcription-history-settings/ui/HistoryTable.tsx`      | context-menu | `ContextMenu.Root + Trigger + Portal + Positioner + Popup + Item` standard.                                |
| `src/widgets/dictionary-settings/ui/DictionaryTable.tsx`              | form         | `<Form>` wrapper around the row's add-form.                                                                |
| `src/widgets/snippets-settings/ui/SnippetsTable.tsx`                  | form         | Same.                                                                                                      |
| `src/widgets/audio-display/ui/DownloadOverlay.tsx`                    | progress     | Progress.Root controlled.                                                                                  |
| `src/widgets/audio-display/ui/FileOverlay.tsx`                        | progress     | Same.                                                                                                      |
| `packages/model-picker/src/core/ModelPicker.tsx`                      | combobox     | Generic shell — see §4 #D1 for the necessary `as never` casts.                                             |
| `packages/model-picker/src/ollama/ui/OllamaModelSelector.tsx`         | combobox     | Composes the shell; no library-pattern issues.                                                             |
| `packages/model-picker/src/ui/OpenRouterModelSelector.tsx`            | combobox     | Composes the shell; uses the same click-tracking helpers as STT picker.                                    |
| `packages/model-picker/src/ui/AuthorFilterSubmenu.tsx`                | combobox     | Submenu-style filter list.                                                                                 |
| `packages/model-picker/src/ui/EndpointProviderFilterSubmenu.tsx`     | combobox     | Same.                                                                                                      |
| `packages/model-picker/src/ui/ModelListContentVirtualized.tsx`        | combobox     | `Combobox.List` + virtua integration.                                                                       |
| `packages/model-picker/src/ui/ModelSelectorTrigger.tsx`               | combobox     | `Combobox.Trigger` render prop + `nativeButton`.                                                            |
| `packages/model-picker/src/ui/Tooltip.tsx`                            | tooltip      | Internal Tooltip used inside the model-picker package (different from `@/shared/ui/tooltip`).               |
| `packages/model-picker/src/ui/DropdownMenu.tsx`                       | menu         | Wrapper around `Menu`; sub-menus use `Menu.SubmenuRoot` + `Menu.SubmenuTrigger` correctly.                  |

---

## 7. Aggregate metrics

| Metric                                                  | Before (this session)                                                          | After                                                                                |
|---------------------------------------------------------|--------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `as never` casts on Base UI props (frontend total)      | 8 (LlmSettingsPanel×2, ModelPicker shell×6)                                    | 6 (ModelPicker shell only — see §4 #D1)                                              |
| `as never` casts elsewhere                              | 8 (same total)                                                                 | 6                                                                                    |
| Manual `<X ? <Check/> : null>` instead of `Combobox.ItemIndicator` | 2 (STT card, OpenRouter Tooltip wrapper not relevant)                | 1 (only the SearchableSelect already-canonical `Combobox.ItemIndicator` usage)        |
| Manual close-reason narrowing via untyped cast          | 1 (`SttModelSelector`)                                                          | 0                                                                                    |
| Stringly-typed Set of slot names                        | 1                                                                              | 0                                                                                    |
| Live-regions in pickers                                 | 0                                                                              | 1 (STT picker `Combobox.Status`)                                                     |
| Manual `onOpenChange(false)` after a dialog action      | 2 (ConfirmDialog, OptInDialog)                                                  | 1 (OptInDialog only — see §4 #D3)                                                    |

---

## 8. Test verification

```text
bun test packages/model-picker/src/
  505 pass / 0 fail / 616 expect()
bun typecheck
  Clean for all session-modified files.
  Pre-existing error: src/shared/ui/text-field/PasswordField.tsx:25 (exactOptionalPropertyTypes, predates session)
```

---

## 9. Open questions

1. **Should `Select.tsx` be rebuilt on `@base-ui/react/select`?** Affects ~15 call sites. The current `Menu.RadioGroup` is functionally OK but semantically wrong (menu vs listbox role). Recommend a dedicated PR — see §4 #D2.
2. **Are the `as never` casts in `ModelPicker.tsx` worth refactoring?** Removing them would require either (a) a non-generic shell (each picker re-implements the chrome), or (b) explicit type parameters threaded through Base UI's internals (TS can't unify them). Both are higher-cost than the documented cast.
3. **Should `Combobox.Status` be added to OpenRouter + Ollama pickers too?** They have the same accessibility gap. Recommended as a follow-up — same one-liner addition.

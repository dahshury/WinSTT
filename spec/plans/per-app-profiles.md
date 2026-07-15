# Plan: Per-App Profiles for LLM Post-Processing

> Generated 2026-07-14 by a Fable planning agent from repository analysis. Status: NOT implemented.

## Part 0 — What the codebase already provides (verified findings)

### 0.1 Context capture: what the Rust side ALREADY captures (requirement 1)

The UIA sidecar `src-tauri/src/bin/winstt_context.rs` emits a single-line JSON snapshot parsed by `src-tauri/src/winstt/context/snapshot.rs` into `WindowContextSnapshot`, which already carries **everything needed for matching**:

- `window_title` — `GetWindowTextW` of the foreground/pinned HWND (all modes).
- `app_exe` — **lowercased exe basename** (e.g. `chrome.exe`) via `OpenProcess` + `QueryFullProcessImageNameW` (`get_process_exe`, winstt_context.rs:750) (all modes).
- `url` — **YES, browser tab URL capture already exists.** `find_browser_url` (winstt_context.rs:1446) reads the omnibox/urlbar **ValuePattern** via the stable UIA AutomationId (`omnibox` for Chromium, `urlbar` for Firefox), for: chrome, msedge, brave, vivaldi, opera, arc, thorium (Chromium) and firefox, librewolf, zen, waterfox (Gecko). It is populated in `Split` and `Tree` modes only (winstt_context.rs:614–629). `Split` is exactly the mode the dictation pipeline uses (post_process.rs:108).

So **nothing new is needed in UIA-land to know the current domain** — only a new lightweight sidecar mode is recommended (below) so profile matching never reads field *text*, and a capture must be added **at recording start** (today the snapshot is only taken *after* decode).

Caveats to encode in matching semantics: the omnibox value is scheme-less and can transiently be user-typed text while editing; Firefox may show a trimmed host. Host-suffix matching (0.4/Part 2) tolerates both.

- Transport: `ContextManager` (`src-tauri/src/winstt/managers/context_manager.rs`) keeps a warm `--serve` sidecar; one request ≈ tens of ms, hard-capped at `SERVE_TIMEOUT_MS = 900`. It supports `--hwnd`-scoped reads (`read_hwnd`, `read_hwnd_with_ocr`).
- Non-Windows: macOS/Linux readers emit `url: ""` always — URL rules are Windows-only; exe/title matching can still work via the sidecar there (there is no in-process fallback off Windows).

### 0.2 Where the pipeline reads config and where focus info exists (requirement 2)

- **Recording start**: `TranscribeAction::start` (`src-tauri/src/actions/transcribe.rs:144`) calls `pinned_foreground::pin()` (line 159) — captures foreground **HWND + PID only** (`src-tauri/src/actions/pinned_foreground.rs`), before any overlay can steal focus. Re-pinned per utterance in all modes (PTT/toggle/wake-word).
- **Post-decode**: `process_transcription_output` (`src-tauri/src/actions/post_process.rs:439`) reads the full settings tree once (`read_settings(app)`, line 455), gates on `settings.llm.dictation.enabled` (line 42–48), captures the Split snapshot of the **pinned** HWND (line 74–125), then calls `process_dictation_text` (`src-tauri/src/winstt/commands/llm.rs:235`) — which **re-reads settings itself** (line 241) and builds the prompt from `settings.llm.dictation` (presets, custom modifiers, provider/model, thinking effort, timeout).
- `transcribe.rs:560` also calls `should_run_winstt_dictation_llm_from_app` (overlay/processing prediction).

### 0.3 Where "configurations" live today (critical architectural fact)

`SavedConfiguration` (named LLM configurations incl. 4 shipped built-ins with stable `builtin:` ids) live **only in frontend localStorage** (`winstt:llm-configurations`), in `src/widgets/llm-settings/model/configurations.ts` (zustand store `useLlmConfigurationsStore`, zod-validated, cross-window synced via `storage` events). Applying one = patching `settings.llm.dictation` via `useSettingsStore.updateLlmPostProcessing` (`src/entities/setting/model/settings-store.ts:265`), which the debounced sync (`src/features/update-settings/api/use-sync-settings.ts`) persists to the single Rust store (`winstt-settings.json`, `src-tauri/src/winstt/settings_store.rs`).

**Consequence**: Rust cannot resolve `configurationId → config` from localStorage. The rules persisted in the settings store must therefore carry a **denormalized config snapshot** (the same field set `postProcessingPatchFromConfiguration` produces — `LlmFeatureBase` + presets + customModifiers, minus `enabled`). The frontend keeps snapshots fresh when a configuration is edited/deleted (Part 3.3). This avoids migrating the whole configurations subsystem into the settings store (large, risky, out of scope).

### 0.4 Existing building blocks to reuse

- App picker: Tauri command `context_list_apps` (`src-tauri/src/winstt/commands/context.rs:49`) → `listContextApps()` (`src/shared/api/ipc/stt-audio.ts:153`), already consumed with icons + fuzzy search by `src/widgets/processing-extras/ui/ContextAllowedAppsSection.tsx`. There is also `context_list_windows`.
- Settings row/section primitives: `SettingField` / `SettingSection` / `SettingSubsection` (`src/entities/setting/ui/`). Dialog primitives: `src/shared/ui/dialog/`, `confirm-dialog`, `modal`. CRUD grids: `EditableRecordsGrid` (`src/shared/ui/data-grid`, see `src/widgets/snippets-settings/ui/SnippetsTable.tsx`) — good for text pairs; rules need structured cells, so use a row list + edit Dialog instead (details Part 3.4).
- Event plumbing: backend event names centralized in `src-tauri/src/winstt/commands/events.rs` (`names::*`, enforced by an emit-coverage frontend test); frontend channels in `src/shared/api/ipc-channels.ts` + listeners in `stt-audio.ts`; hooks mounted in `src/app/providers/IpcProvider.tsx` (see `usePostProcessingProfileSwap`, line 104).
- Transient UI notices: `createTransientNotificationStore` (`src/shared/lib/create-transient-notification-store.ts`, used by configurations.ts).
- Settings save path: `winstt_set_settings` → `apply_settings_patch` → `merge_patch_over`/`accept_section` (`src-tauri/src/winstt/commands/settings.rs:180–336, 416`). The `llm` section is posted **whole** by the renderer and is documented ALL HOT-SWAP — a new sub-section under `llm` needs **zero** changes to `PartialWinsttSettings`, `patch_section_names`, or the merge.

---

## Part 1 — Design decisions (with justification)

**D1. Rules live at `llm.appProfiles` inside the existing `llm` settings section.** Riding inside `llm` (rather than a new top-level section) avoids touching `PartialWinsttSettings`, `merge_patch_over`, `patch_section_names`, the codec's per-section recovery, and sync-helpers. Hot-swap is free: the post-process path re-reads settings per utterance.

**D2. Rules carry a denormalized config snapshot; `configurationId`/`configurationName` are UI linkage only.** See 0.3. A deleted configuration leaves the rule functional on its last snapshot (UI shows a "configuration deleted" badge). The Rust matcher never needs localStorage.

**D3. Resolution happens in Rust, at recording START, into an ephemeral session slot — persisted settings are never mutated by a rule.** Mirrors the pinning discipline (`pinned_foreground.rs`): the window at start is the dictation target; context capture already refuses anything else. Justification for "start wins" over "stop wins": (a) the profile shapes how text is rewritten for the destination the user *intended when speaking* — alt-tabbing mid-dictation to glance at another app must not flip the tone; (b) it is consistent with the existing stale-context rejection (context text is also start-window-scoped); (c) it lets the indicator appear during recording; (d) no re-validation races at stop. An ephemeral override (vs. writing `llm.dictation`) avoids settings-write races, keeps the combobox/default intact, and makes "remove rule → back to default" trivially correct.

**D4. Global post-processing toggle stays authoritative; rules never force post-processing ON.** Simpler and consistent: the codebase already excludes `enabled` from every configuration signature and patch ("the visible toggle owns on/off" — configurations.ts:200–233, modifier-presets.tsx:760). Forcing ON per-app would also trigger surprise Ollama VRAM warm-ups mid-dictation with none of the warm/unload UX the toggle path has (`LlmSettingsPanel.tsx` warm tracker). When `llm.dictation.enabled == false` (or Listen mode), rule resolution is skipped entirely.

**D5. Precedence**: only `enabled` rules with a usable provider are considered. Specificity score = `(urlPattern matched ? 4 : 0) + (titlePattern matched ? 2 : 0) + (appExe matched ? 1 : 0)`; a rule matches iff **every non-empty matcher field matches** (empty fields are wildcards; at least one field must be non-empty). Highest score wins; ties resolved by table order (rules array order). So a `chrome.exe + gmail.com` rule beats a plain `gmail.com` rule beats a plain `chrome.exe` rule. A rule targeting OpenRouter with no API key stored is treated as non-matching (fail-soft to the next rule/default), mirroring `withAvailableLlmProvider` but stricter (skip rather than mutate).

**D6. URL matching = host-suffix matching.** Normalize captured omnibox value and pattern identically: strip scheme, path/query (`/…`), port, lowercase, strip leading `www.`. Match iff `host == pattern || host.ends_with(".{pattern}")` (label-boundary safe: `mail.com` does NOT match `gmail.com`). Title matching = case-insensitive substring. Exe matching = case-insensitive basename compare, `.exe` suffix optional on the user's value.

**D7. Identity capture adds a `Meta` sidecar mode** (title + exe + URL only, no TextPattern/ValuePattern reads of the focused field) so profile matching **never reads user text** — a clean privacy story, and cheaper. Exe + title are additionally captured in-process via Win32 (same calls `pinned_foreground.rs` already makes for PID) so exe/title rules work even if the sidecar is missing; the sidecar request runs **asynchronously** (never delays recording start) and only when ≥1 enabled rule has a `urlPattern`.

**D8. The main combobox is NOT changed by an active rule; a transient "Rule: <name> — <app>" pill appears next to it** (and nothing is persisted). Driven by a new backend event emitted at start-time resolution.

---

## Part 2 — Rust changes

### 2.1 Schema — `src-tauri/src/winstt/settings_schema.rs`

Add next to `LlmSettings` (~line 1345), all with `Serialize, Deserialize, Debug, Clone, PartialEq, Type`, `rename_all = "camelCase"`, per-field `#[serde(default)]` (the file's convention — additive fields migrate for free):

```rust
pub struct AppProfileConfig {
    #[serde(flatten)] pub base: LlmFeatureBase,                       // provider/model/openrouter*/efforts/verbosity/maxOutputTokens
    #[serde(default = "default_neutral_presets")] pub presets: Vec<PresetEntry>,
    #[serde(default)] pub custom_modifiers: Vec<CustomModifier>,
}
pub struct AppProfileRule {
    #[serde(default)] pub id: String,
    #[serde(default = "bool_true")] pub enabled: bool,
    #[serde(default)] pub app_exe: String,          // "" = any app
    #[serde(default)] pub title_pattern: String,    // "" = ignore
    #[serde(default)] pub url_pattern: String,      // "" = ignore
    #[serde(default)] pub configuration_id: String,   // UI linkage only
    #[serde(default)] pub configuration_name: String, // display snapshot
    #[serde(default)] pub config: AppProfileConfig,
}
#[derive(Default)] pub struct AppProfilesSettings { #[serde(default)] pub rules: Vec<AppProfileRule> }
```

`LlmSettings` gains `#[serde(default)] pub app_profiles: AppProfilesSettings,` (+ `Default` impl update at line 1380). Add schema tests mirroring the existing ones (~line 2100): defaults, partial-JSON tolerance, camelCase round-trip (`llm.appProfiles.rules[0].urlPattern` etc.).

### 2.2 Pure matcher — new file `src-tauri/src/winstt/app_profiles.rs` (register in `src-tauri/src/winstt/mod.rs`)

Pure, fully unit-tested, no OS deps:

- `pub struct AppIdentity { pub app_exe: String, pub window_title: String, pub url: String }`
- `fn normalize_exe(&str) -> String` (basename, lowercase, strip trailing `.exe`)
- `fn host_of(url_or_omnibox: &str) -> String` (per D6)
- `fn rule_matches(rule, identity) -> Option<u8>` (specificity score or None; per D5/D6)
- `pub fn resolve_rule<'a>(rules: &'a [AppProfileRule], identity: &AppIdentity, openrouter_key_present: bool) -> Option<&'a AppProfileRule>`
- `pub fn apply_profile_to_settings(settings: &mut WinsttSettings, config: &AppProfileConfig)` — replaces `llm.dictation.base`, `.presets`, `.custom_modifiers`; **keeps** `enabled` and `dictionary_auto_add_enabled`.

### 2.3 Sidecar `Meta` mode

- `src-tauri/src/winstt/context/snapshot.rs`: add `ContextMode::Meta` with flag `Some("--meta")`.
- `src-tauri/src/bin/winstt_context.rs`: add `Mode::Meta` (CLI `--meta`, serve `"mode":"meta"` in `Mode::parse_mode`, line 332); in `capture_json` (line 597) `Meta` fills only `window_title`/`app_exe` (already unconditional) + `url = find_browser_url(...)` — no focused-element reads, no tree walk. Mirror in the non-Windows `NwMode` (url stays `""` there).
- `src-tauri/src/winstt/managers/context_manager.rs`: extend `mode_str` (line 246) with `"meta"` + its exhaustive test (line 544).

### 2.4 Start-time identity capture + session slot — new file `src-tauri/src/actions/app_profile.rs` (peer of `pinned_foreground.rs`; register in `src-tauri/src/actions.rs` mod decls)

State: `static ACTIVE: Lazy<(Mutex<SlotState>, Condvar)>` where `SlotState = Idle | Pending | Ready(Option<ResolvedAppProfile>)`, `ResolvedAppProfile { rule_id, configuration_id, configuration_name, app_exe, config: AppProfileConfig }`.

- `pub(super) fn resolve_at_start(app: &AppHandle, pinned_hwnd: Option<u64>)`, called from `TranscribeAction::start` (transcribe.rs) immediately after `pinned_foreground::pin()` at line 159 (pass the freshly pinned hwnd — add a getter or have `pin()` return it):
  1. Read settings (`crate::winstt::commands::settings::read_settings` — note: actual fn lives in `settings_store.rs:235`, re-exported; follow post_process.rs:455's import). If `!llm.dictation.enabled` || Listen mode || `rules.is_empty()` → set `Ready(None)`, return (zero overhead path).
  2. Capture exe + title in-process via Win32 (`GetWindowThreadProcessId`/`OpenProcess`/`QueryFullProcessImageNameW`/`GetWindowTextW`; copy the ~35-line helper from winstt_context.rs:733–787 — it cannot be imported from the bin target, so lift it into the new module or `winstt/app_profiles.rs` behind `#[cfg(windows)]`).
  3. If no enabled rule has a `url_pattern`, resolve synchronously (pure matcher) → `Ready(...)`; else set `Pending` and spawn a thread: `ContextManager::read_hwnd(ContextMode::Meta, hwnd)` (state via `app.try_state::<Arc<ContextManager>>()`), merge `url` into the identity, resolve, store `Ready(...)`, `notify_all`.
  4. On `Ready(Some(profile))`: emit the event (2.6). On start failure paths that call `pinned_foreground::clear()` (grep its call sites in `transcribe.rs`), also call `app_profile::clear()`.
- `pub(super) fn take_resolved(timeout: Duration) -> Option<ResolvedAppProfile>` — bounded `Condvar` wait (spec 1500 ms; the sidecar cap is 900 ms, decode virtually always exceeds this anyway); `Pending` after timeout → `None` (fail-soft to default config).

### 2.5 Override injection — `src-tauri/src/actions/post_process.rs` + `src-tauri/src/winstt/commands/llm.rs`

- In `process_transcription_output` (post_process.rs:455), right after `read_settings`:
  ```rust
  let mut winstt_settings = ...read_settings(app);
  let active_profile = super::app_profile::take_resolved(Duration::from_millis(1500));
  if let Some(profile) = &active_profile {
      crate::winstt::app_profiles::apply_profile_to_settings(&mut winstt_settings, &profile.config);
  }
  ```
  Everything downstream (`dictation_post_processing_enabled`, `should_run_winstt_dictation_llm`, context capture, encoder-dict gating, replacement pairs) then operates on **effective** settings — this is the single injection point.
- `process_dictation_text` (llm.rs:235) currently re-reads settings (line 241): change its signature to `(app, llm_manager, text, context, settings: &WinsttSettings)`. Callers: post_process.rs:312 passes the effective settings; the Tauri command wrapper at llm.rs:216 (playground/manual path) passes a fresh `read_settings(&app)` — deliberately **no** override there (playground tests what you configured, not per-app rules).
- `should_run_winstt_dictation_llm_from_app` (post_process.rs:50, used at transcribe.rs:560 for the overlay's "will enhance" prediction): apply the same override peek (non-consuming read of the slot with zero wait) so the overlay prediction matches. Make `take_resolved` non-destructive (read-only; slot is overwritten by the next `resolve_at_start`) so both call sites can read it.
- Optional (recommended, 1 line): include `"appProfileRule": profile.configuration_name` in the `llm_meta` JSON at post_process.rs:524 so History shows which rule fired.

### 2.6 Event — `src-tauri/src/winstt/commands/events.rs`

Add `pub const LLM_APP_PROFILE_ACTIVE: &str = "llm:app-profile-active";` to `names` (line 28–69) and emit from `resolve_at_start` (pattern: misc_actions.rs:55 `app.emit(names::LLM_PROFILE_SWAP, ())`) with payload `{ ruleId, configurationId, configurationName, appExe }`. Emit only on a match. The emit-coverage test requires a frontend listener (Part 3.5) — add it in the same PR.

### 2.7 No changes needed (verify only)

- `apply_settings_patch` / `PartialWinsttSettings` / `merge_patch_over` (`settings.rs`) — untouched; `llm` merges whole.
- No runtime side-effect handler needed for rules (`apply_llm_runtime_settings` untouched): resolution reads settings fresh each start = hot-swap.
- Regenerate `src/bindings.ts` via the existing `export_bindings` test path (`make_specta_builder` in `src-tauri/src/commands_registry.rs:49`) so `AppProfileRule`/`AppProfileConfig` types reach the frontend.

---

## Part 3 — Frontend changes

### 3.1 Zod schema — `src/shared/config/settings-schema/llm.ts`

Mirror 2.1: `appProfileConfigSchema = z.object({ ...llmFeatureBaseShape, presets: presetsSchema.default(defaultNeutralPresets), customModifiers: z.array(customModifierSchema).default([]) })`; `appProfileRuleSchema` (id `.min(1)`, `enabled` default true, `appExe`/`titlePattern`/`urlPattern`/`configurationId`/`configurationName` defaulted `""`, `config: appProfileConfigSchema.prefault({})`); `appProfilesSchema = z.object({ rules: z.array(appProfileRuleSchema).default([]).catch([]) })`. Add to `llmSettingsSchema`: `appProfiles: appProfilesSchema.prefault({})`. Update:

- `src/shared/config/settings-contract.ts` — add `llm.appProfiles.rules` under `backendRuntime`.
- `src/shared/config/settings-schema/defaults-parity.test.ts` fixture (Rust↔zod default parity gate).

### 3.2 Settings store — `src/entities/setting/model/settings-store.ts`

Add `updateLlmAppProfiles: (rules: AppSettingsOutput["llm"]["appProfiles"]["rules"]) => void` (shallow-merge into `settings.llm.appProfiles`, next to `updateLlmSettings`, line 189). Persistence/broadcast ride the existing `llm`-section sync for free.

### 3.3 Rules model — new file `src/widgets/llm-settings/model/app-profile-rules.ts`

(Placed inside `widgets/llm-settings` — FSD forbids widget→widget imports and the rules are coupled to `configurations.ts` in this slice.)

- Types from `@/bindings` / `AppSettingsOutput`.
- Pure helpers: `normalizeExeInput` (strip path, lowercase; keep `.exe` optional), `normalizeUrlPatternInput` (strip scheme/path/`www.`), `ruleIsValid` (≥1 matcher field, config chosen), `configSnapshotFromSavedConfiguration(config: LlmConfiguration): AppProfileConfig-shape` (drop `enabled`, mirror `postProcessingPatchFromConfiguration`), `syncRuleSnapshots(rules, configurations)` → `{ rules, changed }` (refresh name+config of rules whose `configurationId` still exists; leave orphans on their last snapshot).
- **Snapshot freshness**: extend `updateConfiguration` and `removeConfiguration` in `src/widgets/llm-settings/model/configurations.ts` (lines 751–784) to call `syncRuleSnapshots` against `useSettingsStore.getState().settings.llm.appProfiles.rules` and write back via `updateLlmAppProfiles` when changed (widgets → entities import is FSD-legal; the settings sync persists + broadcasts). Renames flow through `updateConfiguration`; deletion leaves an orphan badge.

### 3.4 UI — new files under `src/widgets/llm-settings/ui/`

- `AppProfileRulesSection.tsx` — rendered by `LlmSettingsPanel.tsx` inside the existing boxed `SettingSection` below the `FeatureBlock` wrapper (line 176–213), as a `SettingSubsection` titled "Per-app profiles". Greyed/disabled (with tooltip) when `effectivePostProcessingEnabled` is false (D4). Contents:
  - Rule rows (custom list, not `EditableRecordsGrid` — cells are structured): app icon+label (icon via `listContextApps` cache when running, else monogram like `AppIcon` in ContextAllowedAppsSection.tsx:121), matcher summary (`chrome.exe · title contains "…" · gmail.com`), configuration name (+ "configuration deleted" badge for orphans), per-row enable `Toggle`, edit + delete buttons (delete via `confirm-dialog`). Row order = precedence tiebreak; reuse the drag-reorder affordance pattern from `CreatableCombobox`'s `leadingReorderHandle` if cheap, else up/down buttons.
  - Pinned footer row: "Everything else → <default>", where <default> = `resolveActivePostProcessingPreset(settings.llm.dictation)?.name ?? "Custom"` (from `use-post-processing-profile-swap.ts:46`) — the clear fallback indication.
  - "Add rule" button → dialog.
- `AppProfileRuleDialog.tsx` — compound Dialog (`@/shared/ui/dialog`) with settings-row styling: (1) **App** — combobox of running apps via `listContextApps()` (reuse the load/fuzzy/AppIcon pattern from `ContextAllowedAppsSection.tsx`) that also accepts free text for non-running apps (normalized via `normalizeExeInput`); optionally an exe file-picker if `tauri-plugin-dialog` is already in `src-tauri/Cargo.toml` (check; skip if absent — free text covers it). (2) **Window title contains** (optional). (3) **Website domain** (optional; helper text: "Browsers only — e.g. gmail.com. Matches subdomains."). (4) **Configuration** — select over `useLlmConfigurationsStore().configurations` with the profile icons (`profile-icons.ts`). Validation per `ruleIsValid`; Save writes normalized rule + snapshot via `updateLlmAppProfiles`.
- Indicator: new `src/widgets/llm-settings/model/use-app-profile-indicator.ts` — a `createTransientNotificationStore<{ configurationName, appExe }>` fed by the new event listener; mount the subscription hook in `src/app/providers/IpcProvider.tsx` next to `usePostProcessingProfileSwap()` (line 104). Render a small pill ("Rule: Formal Email — chrome.exe", ~4 s) beside `PostProcessingProfilesCombobox` in `LlmSettingsPanel.tsx` header (line 140–162); optionally reuse it in `src/views/tray-indicator/ui/TrayIndicatorPage.tsx` (it already surfaces profile names, lines 114/145) — mark optional.

### 3.5 IPC plumbing

- `src/shared/api/ipc-channels.ts`: `LLM_APP_PROFILE_ACTIVE: "llm:app-profile-active"` + registry entry `["on"]` (near line 595 pattern).
- `src/shared/api/ipc/stt-audio.ts`: `onAppProfileActive = (cb) => onTyped(IPC.LLM_APP_PROFILE_ACTIVE, ...)` (pattern: line 474).

### 3.6 i18n

Add keys under the `llm` namespace in `messages/en.json` (`appProfilesTitle`, `appProfilesCaption`, `appProfileAddRule`, matcher labels, orphan badge, default-row label, indicator text, dialog labels/validation) and mirror into the other 19 locale files per repo convention.

---

## Part 4 — Step ordering

1. **Schemas + parity**: 2.1 Rust structs + tests → 3.1 zod + contract + defaults-parity → regenerate bindings.ts. (Everything else depends on types.)
2. **Pure matcher** (2.2) + tests — no OS deps, parallelizable.
3. **Sidecar Meta mode** (2.3) + serve/mode tests.
4. **Start-time capture + slot + event** (2.4, 2.6) + wire into `TranscribeAction::start`; frontend listener stub (3.5) so emit-coverage passes.
5. **Override injection** (2.5): `process_dictation_text` signature change first (mechanical), then the injection + telemetry.
6. **Frontend model** (3.2, 3.3) + tests.
7. **UI** (3.4, 3.6) + tests.
8. **Verification**: `cargo test` in src-tauri; `bun run test`; Biome; knip; manual: create rule chrome.exe+gmail.com → dictate into Gmail → History shows rule model/meta; alt-tab mid-dictation → start app wins; delete rule → default applies.

## Part 5 — Edge cases (must be handled/tested)

- No foreground window / pin invalid at start → identity empty → no match → default.
- Sidecar missing (`ContextManager::is_available` false) → exe/title rules still work (in-process Win32); URL rules never match on that machine.
- Omnibox mid-edit (search text) → host parse yields non-matching garbage → falls through (by design).
- Two browser windows: Meta read is `--hwnd`-scoped to the pinned window.
- Tab switched during dictation: URL from start wins (D3) — document in tooltip.
- Ultra-short utterance vs. async URL resolve: bounded Condvar wait (1500 ms) then default.
- Rule → OpenRouter with key since removed → rule skipped (D5), next match/default applies.
- Orphaned rule (configuration deleted) → runs on snapshot; badge in UI.
- Toggle-mode 2nd..N utterances: re-resolved per `TranscribeAction::start` (same as re-pinning).
- Listen mode / post-processing off: resolution skipped entirely; UI section disabled.
- Empty rules list: zero-cost early-out at start.
- Non-Windows: exe/title via sidecar only, URL always empty — matcher is platform-agnostic, capture degrades.

## Part 6 — Test list

**Rust (`cargo test`, src-tauri):**
1. `winstt/app_profiles.rs`: exe normalization (case/path/`.exe`-optional); title substring case-insensitivity; `host_of` (scheme-less omnibox, full URL, port, path, `www.`); domain suffix (`gmail.com` matches `mail.gmail.com`, NOT `notgmail.com`; `mail.com` !~ `gmail.com`); all-non-empty-fields-must-match; specificity 4/2/1 ordering; tie → array order; disabled skipped; keyless-OpenRouter skipped; `apply_profile_to_settings` preserves `enabled`/`dictionary_auto_add_enabled`.
2. `actions/app_profile.rs`: slot Idle/Pending/Ready; bounded-wait timeout → None; clear on failed start (mirror `pinned_foreground` test style incl. its `TEST_LOCK`).
3. `settings_schema.rs`: appProfiles defaults; partial-JSON tolerance; camelCase round-trip.
4. Sidecar/manager: `Mode::parse_mode("meta")`; `mode_str(ContextMode::Meta)`; `serve_request_line` with Meta.

**Frontend (`bun test`, happy-dom):**
5. schema: defaults, `.catch([])` on corrupt rules, unknown-field tolerance; defaults-parity fixture.
6. `app-profile-rules.test.ts`: input normalizers; `ruleIsValid`; `configSnapshotFromSavedConfiguration` drops `enabled`; `syncRuleSnapshots` (rename, content edit, delete-orphan untouched, no-op stability).
7. `configurations.test.ts` additions: `updateConfiguration`/`removeConfiguration` trigger rules re-sync through the settings store.
8. `settings-store.test.ts`: `updateLlmAppProfiles` patches only `llm.appProfiles`.
9. `use-app-profile-indicator.test.tsx`: event → transient store → auto-dismiss.
10. `AppProfileRulesSection.test.tsx`: rows render; disabled when post-processing off; delete confirm; orphan badge; default-row shows matched preset name / "Custom".
11. `AppProfileRuleDialog.test.tsx`: running-app list (mock `listContextApps`), free-text exe normalization, validation gating Save, saved rule shape.
12. emit-coverage test: new event const ↔ listener pairing passes.

## Critical Files for Implementation
- `src-tauri/src/actions/post_process.rs` — override injection point (`process_transcription_output`, line 455) and all gating
- `src-tauri/src/winstt/settings_schema.rs` — Rust schema home for `llm.appProfiles` (LlmSettings, line 1345)
- `src-tauri/src/actions/transcribe.rs` — recording-start hook (`TranscribeAction::start`, line 144; pin at 159)
- `src/widgets/llm-settings/model/configurations.ts` — SavedConfiguration store the rules link to and must stay snapshot-synced with
- `src/shared/config/settings-schema/llm.ts` — frontend Zod schema mirror (llmSettingsSchema, line 178)

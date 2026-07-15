# Plan: Spec-Based "Suggested" Filter for Local Model Pickers

> Generated 2026-07-14 by a Fable planning agent from repository analysis. Status: IMPLEMENTED 2026-07-14 (all 7 steps; see deviations noted per-picker — TTS integrated into the newer TTS filter menu instead of the chip-only fallback, Ollama library rows gate at the quant shelf only, default-ON flag excluded from active-filter counts).

## Part 1 — Verified existing machinery (exact paths)

### Catalogs & scores
| What | File | Fields |
|---|---|---|
| STT catalog store | `src/entities/model-catalog/model/catalog-store.ts` | `ModelInfo`: `accuracyScore`/`speedScore` (0..1, **0.5 = unknown sentinel**), `availableQuantizations`, `sizeBytesByQuantization`, `languages`, `supportsLanguageDetection`, `family` |
| STT per-model state | `src/entities/model-catalog/model/model-state-store.ts`; DTO in `src/bindings.ts` (~line 2962) | `ModelStateEntry`: `effective_quantization`, `estimated_bytes` (fp32 baseline = param_count × 4), `comfortable_on_gpu`, `comfortable_on_cpu`, `cache_by_quantization` |
| TTS catalog | `src/entities/tts-catalog/model/tts-catalog-store.ts` | `TtsModelInfo`: `qualityScore`/`speedScore` (same 0.5 sentinel), `languages`, `availableQuantizations`, `sizeBytesByQuantization`, `paramCountM` |
| TTS state | `src/shared/api/ipc/llm-tts.ts` (line 470) | `TtsModelStateEntry`: `estimatedBytes`, `effectiveQuantization`, `cacheByQuantization` |
| Ollama installed models | `src/entities/llm-catalog/model/llm-catalog-store.ts` | `OllamaModel.size` (GGUF bytes) |
| Ollama library tags (quants) | `src/entities/llm-catalog/model/ollama-library-store.ts`; `OllamaLibraryTag` in `src/shared/api/models.ts` | per-tag `sizeBytes`, `quantization`, `parameterSize` |
| Curated LLM list | `src/entities/llm-catalog/lib/recommended-models.ts` | `sizeBytes`, `paramSize` per entry |
| models.dev enrichment | `src/entities/llm-catalog/lib/models-dev.ts` | metadata only (no accuracy/speed scores) |
| Spec cards | `src/widgets/model-picker/{stt,tts,ollama}/lib/build-{stt,tts,ollama}-spec.ts` | hover-card assembly from the above |

### Footprint / quant machinery ("effective quantization bridge")
- **`src/entities/system-resources/lib/fit-assessor.ts`** — the client footprint engine: `BYTES_PER_PARAM_BY_QUANT` (fp32 4 / fp16 2 / int8 1.2 / 4-bit 0.75), `estimateForQuant(estimatedBytes, quant)` (exported; already reused by the status-bar breakdown), `GPU_COMPATIBLE_QUANTIZATIONS` (only `""`,`fp32`,`fp16`,`fp16w` can run on the GPU EP), `predictedTarget`, `cpuBudgetBytes` (`RAM_USABLE_FRACTION = 0.7`), `largestGpu`, `assessDictationFitClient`.
- **`src/entities/model-catalog/lib/quant-cache.ts`** — `resolveEffectiveQuant` — the "effective quantization bridge": server's RAM/VRAM-aware auto pick surfaces as `entry.effective_quantization`.
- **Rust source of truth**: `src-tauri/src/winstt/stt/quant_resolve.rs` — `bytes_per_param`, `runtime_footprint_bytes`, `fit_aware_auto_quant` (RAM/VRAM-aware auto-quant, incl. the CPU-EP "fp16 is slow" ordering), `override_dml_to_cpu_for_kind` (**the per-engine device pin matrix**). `src-tauri/src/winstt/commands/catalog_data.rs` — `is_comfortable_on_gpu/cpu` (`GPU_HEADROOM = 1.5`, `CPU_HEADROOM = 2.0`), `models_with_state`.
- RAM-aware auto-quant **marking in the picker**: `src/widgets/model-picker/stt/lib/quantization-helpers.ts` (the "Recommended" mark is whatever badge equals `effective_quantization`; card-body click selects it).

### Hardware detection & per-modality memory
- Live snapshot store: `src/entities/system-resources/model/system-resources-store.ts` (`liveResources: LiveResourcesEntry` — `ram_total_bytes`, `ram_available_bytes`, `gpus[].total/free_vram_bytes`; type at `src/shared/api/ipc/models.ts:296`).
- Static system info (`SystemInfoEntry`) threaded into pickers via `src/widgets/model-picker-window/lib/picker-helpers.ts` and `ModelSettingsPanel`.
- **The GPU-chip per-modality breakdown** (STT / TTS / dictionary / post-LLM rows with `memBytes` + `device`): pure builder `src/features/connect-server/lib/runtime-model-breakdown.ts` (`buildRuntimeBreakdown`), hook `src/features/connect-server/model/use-runtime-model-breakdown.ts`. This is where "which models are enabled per modality and what they cost" is already assembled from `useSettingsStore` (`settings.model`, `settings.tts.enabled/source/model`, `settings.llm.dictation.enabled/provider/model`, `settings.general.encoderDictionaryEnabled`) — the budget calculator should mirror exactly these inputs.

### Picker filters, favorites, persistence
- STT: `src/widgets/model-picker/stt/lib/filter-state.ts` (`SttFilterState`: `cachedOnly`, `realtimeOnly`, `fitsHardwareOnly`, `languages[]`), menu `stt/ui/SttFiltersMenu.tsx` (supports `lockedFilterKeys`), sort `stt/lib/sort-state.ts`, UI state + persistence `stt/ui/stt-selector-ui-state.ts` + `src/shared/lib/persisted-selector-state.ts` (per-picker `uiStorageKey`, keys in `src/shared/lib/model-picker-ui-storage-keys.ts`).
- Ollama: `src/widgets/model-picker/ollama/lib/filter-state.ts` (`installedOnly`, `fitsHardwareOnly`; lenient "unknown size = fits"), menu `ollama/ui/OllamaFiltersMenu.tsx` (`showHardwareFilter: !!systemFit` in `OllamaModelSelector.tsx:688`), quant shelf `ollama/ui/OllamaQuantShelf.tsx` (already calls `getFit(tag.sizeBytes)` per tag at line 189) + `ollama/lib/quant-shelf-helpers.ts` (`tagsForParamSize`, `pruneToShownQuants` — canonical ladder QAT/q4_K_M/q5_K_M/q8_0/fp16).
- TTS: `src/widgets/model-picker/tts/ui/TtsModelSelector.tsx` — **currently has NO filter reducer/menu** (comment at line 647).
- Favorites: `src/widgets/model-picker/core/favorites.ts`, `core/use-favorite-set.ts`, `stt/lib/use-favorite-stt-models.ts`, `ollama/lib/use-favorite-ollama-models.ts`.
- Languages: user preference = `settings.model.language` (forced decode language), `autoDetectLanguage`, `languageCandidates` (see `src/bindings.ts:2908-2924`); compatibility helpers **already exist**: `src/entities/model-catalog/lib/source-language-compatibility.ts` (`resolveSelectedSourceLanguages`, `modelSupportsSelectedSourceLanguages` — already used as the realtime-picker prefilter in `PickerBody.tsx:360`).
- Hosts that wire pickers: `src/widgets/model-picker-window/ui/PickerBody.tsx`, `src/widgets/model-settings/ui/ModelSettingsPanel.tsx` (+ `model/use-model-fit-assessment.ts`), `src/widgets/llm-settings/ui/provider-sections.tsx`, `src/widgets/tts-settings/ui/TtsModelPickerHost.tsx`.

---

## Part 2 — Current fit-logic findings (requirement 1)

**Verdict on "fit pools inverted": the bug is real, though "inverted" is imprecise — it is a wrong-pool-selection + wrong-aggregation pair:**

1. **Wrong pool selection (frontend)** — `src/widgets/model-picker/stt/lib/filter-state.ts:77-92`: the `fitsHardwareOnly` filter picks the pool by *hardware presence*, not by *where the model actually runs*: `hasGpu(sys) ? entry.comfortable_on_gpu : entry.comfortable_on_cpu`. But CPU-pinned engines (CohereAsr, Kaldi transducers — `override_dml_to_cpu_for_kind`) and all non-fp GPU-incompatible quants (int8/uint8/q4… per `GPU_COMPATIBLE_QUANTIZATIONS`) consume **RAM**, never VRAM. On a big-RAM / small-VRAM GPU machine, CPU-routed models are judged against the VRAM pool → **wrongly excluded**; on a big-VRAM / small-RAM machine the inverse → **wrongly included**. This is the "pools inverted" symptom.
2. **Wrong GPU aggregation (backend)** — `src-tauri/src/winstt/commands/catalog_data.rs:324-339`: `is_comfortable_on_gpu` requires the footprint to fit on **`.all()`** GPUs. Any iGPU + dGPU host (very common) fails almost everything because the iGPU is tiny. The client fit-assessor correctly uses `largestGpu` — the two disagree.
3. **Per-model, not per-quant** — `comfortable_on_*` is computed **once, at the effective quant only** (`catalog_data.rs:618-619`), and the picker's filter consumes that single verdict. Confirmed suspicion: no per-quant fit exists in the filter path. (Note the effective quant itself *is* fit-aware via `fit_aware_auto_quant`, which softens the "largest quant" concern — but when nothing fits its budget it falls back to the most-compact quant, and `comfortable_*` is then computed against `CPU_HEADROOM = 2.0` on *total* RAM, a stricter test with different constants, so models that fit at a low quant can still be filtered out. Also the frontend never re-checks other quants when the user picks one explicitly.)
4. **Two disagreeing frontend predicates** — `stt/lib/hardware-fit.ts` (`fitsSomewhere` = GPU **OR** CPU pool, lenient union) vs `stt/lib/filter-state.ts` (single pool by GPU presence). Same data, opposite semantics; card badge and filter can contradict each other.
5. **Ollama** — `src/entities/llm-catalog/lib/hardware-fit.ts:120-128`: if a GPU exists, fit = VRAM-only (intentionally no RAM fallback, per its comment) — pessimistic for large-RAM machines and inconsistent with STT's semantics.

The new suggestion engine must not inherit any of these; fix (1) and (2) opportunistically or at minimum bypass them.

---

## Part 3 — New module design: `src/entities/model-suggestion`

New entity slice (mirrors the `system-resources` entity pattern: pure `lib/` importing only `@/shared`, structural input types so all three catalogs can feed it — same trick as `CatalogSizeInfo` in `runtime-model-breakdown.ts`).

```
src/entities/model-suggestion/
  index.ts
  lib/quant-tiers.ts        // penalty/bonus tables + effective scores
  lib/memory-budget.ts      // shared cross-modality budget calculator
  lib/per-quant-fit.ts      // fit of one (model, quant) against a budget
  lib/bang-for-buck.ts      // ranking formula
  lib/suggest.ts            // orchestration: model list -> SuggestionResult
  (+ .test.ts beside each)
```

### 3.1 Quant tier tables (`quant-tiers.ts`) — requirement 2

Base `accuracyScore`/`speedScore` are per model at the natural (fp32/largest) export. Encode systematic degradation as tunable constant maps keyed by `OnnxQuantization` (from `src/shared/config/defaults.ts:25`), documented with the measured evidence already in the repo (`quant_resolve.rs` comments, `QUANTIZATION_WEIGHT` in `quantization-helpers.ts`):

```ts
// Additive on the 0..1 normalized scores; clamped to [0, 1].
export const QUANT_ACCURACY_PENALTY: Record<OnnxQuantization, number> = {
  "": 0, fp16: 0.01, fp16w: 0.01, int8: 0.03, uint8: 0.03,
  q4f16: 0.06, int4: 0.08, q4: 0.08, bnb4: 0.08,
};
// Speed adjustment DEPENDS ON THE ROUTED DEVICE (mirrors CPU_ORDER in
// quant_resolve.rs: ORT's CPU EP up-casts fp16 -> 4-8x SLOWER, measured).
export const QUANT_SPEED_DELTA_GPU: Record<OnnxQuantization, number> = {
  "": 0, fp16: 0.10, fp16w: 0.05, int8: 0.05, uint8: 0.05, q4f16: 0.08, int4: 0.08, q4: 0.08, bnb4: 0.08 };
export const QUANT_SPEED_DELTA_CPU: Record<OnnxQuantization, number> = {
  "": 0, int8: 0.08, uint8: 0.08, q4: 0.12, int4: 0.12, bnb4: 0.12,
  fp16: -0.30, fp16w: -0.30, q4f16: -0.20 };
```

`effectiveScores(base, quant, device)` returns `{accuracy, speed}` clamped. The 0.5 unknown sentinel passes through untouched (consistent with `sort-state.ts` "unknown lands mid-pack"). For Ollama, map tag quant labels (`Q4_K_M`→q4 tier, `Q8_0`→int8 tier, `fp16`→fp16 tier, `QAT`→int4 tier, default/latest→q4 tier since Ollama defaults are Q4_K_M).

### 3.2 Shared budget calculator (`memory-budget.ts`) — requirements 4, 5

Single source of truth used by all three pickers:

```ts
export interface CommittedModel { bytes: number; device: "gpu" | "cpu"; modality: "stt" | "tts" | "llm" | "dictionary"; }
export interface MemoryBudgets { ramBytes: number; vramBytes: number; hasGpu: boolean; }
export function computeBudgets(sys: { totalRamBytes: number; largestGpuVramBytes: number },
  committed: readonly CommittedModel[], excludeModality: Modality): MemoryBudgets
```

- Base pools: `ram = totalRamBytes × RAM_USABLE_FRACTION (0.7)`; `vram = largestGpuVramBytes / GPU_HEADROOM (1.5)` — i.e. reuse the existing constants, expressed as budget so the fit test is a plain `bytes <= budget`. Use **largest GPU** (fixes finding 2; matches `largestGpu` in fit-assessor).
- Subtract every committed model of **other** modalities from its own pool (`device` decides RAM vs VRAM). The modality being picked is excluded so swapping replaces, not stacks (mirrors the `freedSlotFootprint` idea in `fit-assessor.ts`).
- **Deliberately totals-based, not live-free-based**: the Suggested list answers the static capability question ("can this machine run it well") and must be stable while the picker is open; the existing live per-row badges (`assessDictationFitClient` + `useSystemResourcesStore`) stay unchanged and complementary. This also avoids double-counting already-resident models that live-free readings include.

**Committed-model source (hosts):** reuse the exact input assembly of `use-runtime-model-breakdown.ts`. Add a small hook `src/features/suggested-models/model/use-committed-models.ts` (new feature slice) that maps the same settings/store reads into `CommittedModel[]`:
- STT: `estimateForQuant(state.estimated_bytes, resolveEffectiveQuant(state, settings.model.onnxQuantization))`, device from routing (see 3.3); include the realtime slot when distinct.
- TTS (when `settings.tts.enabled && source === "local"`): `TtsModelStateEntry.estimatedBytes` (fallback `sizeBytesByQuantization`), device = GPU when accelerator is GPU (matches `ttsSection`).
- LLM (when `settings.llm.dictation.enabled && provider === "ollama"`, and likewise transforms): installed `OllamaModel.size` × Ollama headroom, device = GPU if present (matches `postSection`/`assessOllamaFit`).
- Encoder dictionary (when enabled): fixed 310 MB CPU (constant already in `fit-assessor.ts` / `runtime-model-breakdown.ts` — export one, delete the duplicate).

### 3.3 Per-quant fit (`per-quant-fit.ts`) — requirements 1, 5, 8

`quantFits(bytesAtQuant, device, budgets): boolean`, plus per-catalog byte estimators:
- STT: `estimateForQuant(entry.estimated_bytes, quant)` (import from `@/entities/system-resources` — entity→entity import already practiced by `runtime-model-breakdown.ts`; if lint forbids it, re-export via a structural callback param).
- Device per (model, quant): the pin matrix is Rust-only today. **Backend addition (small, recommended):** extend `ModelStateEntry` (DTO in `src-tauri/src/winstt/commands/catalog_data/dto.rs`, builder `to_state_entry` in `catalog_data.rs`) with `device_by_quantization: BTreeMap<String, String>` ("gpu"/"cpu") computed via `override_dml_to_cpu_for_kind(providers_for_accelerator(accel), kind, quant)` per published quant. Update the zod schema in `model-state-store.ts` with `.default({})` (older-server compat) and the Rust↔TS parity test `catalog-model-info.parity.test.ts`. Frontend fallback when absent: `GPU_COMPATIBLE_QUANTIZATIONS.has(quant) && hasGpu` (today's `predictedTarget` heuristic).
- TTS: bytes = `sizeBytesByQuantization[quant]` × 1.2 headroom (disk ≈ resident for ONNX); device = global accelerator.
- Ollama: bytes = `tag.sizeBytes × 1.2 + 1 GB` (reuse `requiredRuntimeBytes` from `entities/llm-catalog/lib/hardware-fit.ts` — export it); **fix the pool rule**: fits if VRAM budget covers it **or** RAM budget covers it (GPU-preferred, RAM fallback allowed — Ollama does CPU/partial offload; keep the existing VRAM-only rule for the *warning chip*, but the Suggested filter should not hide a model a 64 GB-RAM box runs fine). Unknown sizes remain "fits" (lenient rule already established in `ollama/lib/filter-state.ts`).

A model is *suggestible* iff **any** published quant fits (STT: every entry of `availableQuantizations`; Ollama: every canonical shelf tag from `tagsForParamSize` + `pruneToShownQuants`, or the single `sizeBytes` for recommended/installed cards when tags aren't fetched yet).

### 3.4 Ranking (`bang-for-buck.ts`) — requirement 3

Per (model, quant): F-beta-style weighted harmonic mean of effective accuracy and effective speed:

```
score(A, S) = (1 + β²)·A·S / (β²·A + S),  β = SUGGEST_BETA = 0.5   // accuracy weighted 2x speed
```

Justification (document in the file): harmonic form enforces a *soft speed floor* — a very slow model can't ride a high accuracy score to the top (multiplicative punishment of near-zero terms), which is exactly "runs *well*", while β=0.5 keeps accuracy primary (dictation users tolerate 1.5× slower, not 5% worse WER). Constants exported for tuning. Model's headline score = **max over its fitting quants**; also return `bestQuant` for display. Tie-break by name (reuse `makeNameComparator`). Ollama (no published scores): proxy accuracy = log-normalized param count, speed = 1 − (bytes/pool budget) clamped — documented as a proxy in constants (`OLLAMA_PARAM_LOG_MIDPOINT` etc.), same formula on top.

### 3.5 Language rule — requirement 6

- **STT: exclude.** Reuse `modelSupportsSelectedSourceLanguages(model, selection, mainModel)` with `selection = settings.model` (`language`, `autoDetectLanguage`, `languageCandidates`). Rationale: a model that cannot transcribe the user's dictation language is useless regardless of fit — and this exact exclusion is already the precedent in the realtime prefilter (`PickerBody.tsx:360`). Multilingual/unknown (`languages: []`) always passes.
- **TTS: de-rank, not exclude** (×`LANGUAGE_MISMATCH_FACTOR = 0.5` on the score when the TTS model's `languages` don't intersect the resolved preferred set). Rationale: read-aloud output language may legitimately differ from dictation language; hiding would be wrong, but mismatches shouldn't outrank matches.
- **Ollama: no language rule** (no per-model language metadata; LLM cleanup is largely language-agnostic).

---

## Part 4 — UI changes per picker (requirement 7)

Behavior when Suggested is ON (all pickers): (a) models with **no fitting quant** are hidden; (b) shown models' quant badges outside the fitting set render disabled/greyed with tooltip "Needs more memory than this machine has free" (STT: `SttModelCard.tsx` quant shelf, gate the badge click; the existing "Recommended" auto-quant mark is untouched — the server's `effective_quantization` is fit-aware and will be inside the fitting set by construction, add a test); (c) when no explicit sort is active, the list flattens into a single bang-for-buck-sorted column (reuse the existing `SORTED_GROUP_KEY` flatten path in each selector; header label "Suggested · best for your machine" alongside `STT_SORT_HEADER_LABEL`). A user-chosen sort key overrides (c) but not (a)/(b).

- **STT** (`SttModelSelector.tsx`): add `suggestedOnly: boolean` to `SttFilterState` (`stt/lib/filter-state.ts`), **default `true`** in `EMPTY_FILTER_STATE`. Add to `TOGGLE_KEYS` + `FILTER_FLAGS` in `SttFiltersMenu.tsx` (icon suggestion: `SparklesIcon`), and render it *also* as an always-visible chip next to the filter trigger (one-tap toggle; the menu checkbox and chip share state). Composition: `filterSttModels` gains a `suggested` context (predicate injected by host) applied as one more `checks[]` entry — composes with cachedOnly/realtime/languages/search untouched. Keep the legacy `fitsHardwareOnly` flag as-is (it still means "comfortable at the effective quant"; do not remove — but fix its pool-selection bug per Part 2 finding 1 while there: choose the pool from the routed device of the effective quant, and stop requiring all-GPUs in Rust).
- **Realtime STT picker**: same state via its own `uiStorageKey`; suggested predicate composes with the existing realtime `prefilter`.
- **TTS** (`TtsModelSelector.tsx`): has no filter machinery — add only a single persisted "Suggested" chip in the header (no full menu), default ON, filtering `models` before grouping and disabling non-fitting quant badges in `TtsModelCard.tsx`.
- **Ollama** (`OllamaModelSelector.tsx`): add `suggestedOnly` to `OllamaFilterState` (default true; update `isOllamaFilterState` guard to *default* a missing key to `true` rather than reject). Apply to all three sections: installed (hide when no quant fits — lenient on unknown size), recommended (`filterRecommendedOllamaModels`), library rows. Quant shelf: reuse the existing per-tag `getFit` call site (`OllamaQuantShelf.tsx:189`) but pass the new budget-aware fit; disable non-fitting tag badges. Sort recommended+library by bang-for-buck proxy when ON.
- **Cloud exemption**: `OpenRouterModelSelector`, `CloudModelSelect`, ElevenLabs/cloud TTS sections get no changes; the flag lives only in the three local pickers' state.
- **Favorites interaction (decision)**: filters apply to favorites too (a starred model with no fitting quant hides while Suggested is ON) — consistent with how `cachedOnly` already prunes favorites, and the chip is one tap to disable. Add a one-line hint in the empty state ("N models hidden by Suggested — tap to show all", extend `lib/EmptyState.tsx`).
- **Auto-quant interaction (decision)**: unchanged; when the user clicks a card body, `resolveEffectiveQuant` still decides. Suggested only constrains *explicit* badge picks.

### Persistence (decision)
**Per picker**, via the existing `persisted-selector-state.ts` + `uiStorageKey` mechanism (STT main / STT realtime / TTS / Ollama dictation / Ollama transforms each keep their own flag) — this is what the infra already does for every other filter, and per-surface intent genuinely differs (users browsing the library may want it off there but on in dictation). **Migration rule**: persisted blobs written before this feature lack the key — the validators (`isPersistedSttSelectorUiState`, `isOllamaFilterState`) must treat *missing* `suggestedOnly` as `true` (default ON for existing users), not as invalid state. Unit-test this.

---

## Part 5 — Data flow

```
settings store (enabled models, quant, language prefs, device)
   + catalog stores (STT/TTS/Ollama)  + model-state stores (estimated bytes, eff quant, device_by_quantization)
   + system info (total RAM, largest GPU VRAM)
        │
        ▼
features/suggested-models/model/use-committed-models.ts   (per-modality CommittedModel[])
        │
        ▼
entities/model-suggestion  (pure: computeBudgets → per-quant fit → effective scores → bang-for-buck)
        │
        ▼
hosts (ModelSettingsPanel, PickerBody, TtsModelPickerHost, llm-settings provider-sections)
  build   getSuggestion(modelId) => { visible, fittingQuants: Set<string>, score, bestQuant }
        │  (same threading pattern as existing getFitAssessment / systemFit props)
        ▼
pickers (SttModelSelector / TtsModelSelector / OllamaModelSelector) — presentational, filter + sort + badge-gating
```

## Part 6 — Step ordering

1. **Pure engine + tests** — `entities/model-suggestion` (tiers, budgets, per-quant fit, ranking, suggest orchestration). No UI. `bun test ./src/entities`.
2. **Backend** — `device_by_quantization` on `ModelStateEntry` (`catalog_data.rs`, `dto.rs`), zod default in `model-state-store.ts`, parity test update. Also fix `is_comfortable_on_gpu` `.all()` → largest GPU, and the pool-selection bug in `stt/lib/filter-state.ts` (findings 1–2).
3. **Committed-models hook** — `features/suggested-models` (+ tests against fixed store snapshots, like `runtime-model-breakdown.test.ts`).
4. **STT picker** — filter state + menu + chip + quant-badge gating + sort integration + persistence default-ON migration; wire hosts (`ModelSettingsPanel`, `PickerBody` main+realtime, onboarding step untouched).
5. **Ollama picker** — filter state, three sections, quant shelf per-tag gating, proxy ranking; wire `PickerBody.DetachedOllamaPicker`, `llm-settings/provider-sections`, onboarding hook.
6. **TTS picker** — chip + filtering + badge gating; wire `TtsModelPickerHost` + `DetachedTtsPicker`.
7. Biome pass, i18n strings (`modelPicker.*` namespace), docs page touch (`docs/content/docs/settings/…` if pickers are documented).

## Part 7 — Test list (bun test, colocated `.test.ts`)

**Scoring math** (`quant-tiers.test.ts`, `bang-for-buck.test.ts`): penalty/bonus application + clamping; CPU-routed fp16 speed *penalty*; 0.5-unknown passthrough; harmonic score punishes near-zero speed (accuracy 0.9/speed 0.05 ranks below 0.7/0.6); best-quant selection per model; Ollama proxy monotonicity.

**Budget subtraction** (`memory-budget.test.ts`): TTS+LLM enabled → STT budget reduced by both, in the correct pools (CPU-pinned LLM reduces RAM not VRAM); picking modality excluded from its own subtraction (swap semantics); encoder-dict 310 MB CPU-only; no GPU → vram budget 0; iGPU+dGPU → largest GPU wins; disabled/cloud modalities contribute 0.

**Per-quant fit edges** (`per-quant-fit.test.ts`): big model unfit at fp32 but fit at int8 → model visible with int8-only fitting set (the headline bug); int8 never budgeted against VRAM even on GPU hosts; unknown footprint (`estimated_bytes <= 0`) → lenient visible-all-quants; zero-size Ollama tag → fits; `device_by_quantization` absent (old server) → heuristic fallback path.

**Filter composition & persistence**: `suggestedOnly` composes with cachedOnly/languages/search/realtime prefilter; favorites hidden when unfit; missing persisted key defaults ON (both STT and Ollama validators); locked-filter interplay in `SttFiltersMenu`.

**Language**: STT exclusion honors `languageCandidates` > pinned `language` > auto (reuse `source-language-compatibility` fixtures); TTS de-rank factor applied, not hidden.

**UI**: `SttModelCard` disables non-fitting quant badges + keeps Recommended mark inside fitting set; `OllamaQuantShelf` disables non-fitting tags; sorted-header label appears when ON with no explicit sort (extend existing `SttFiltersMenu.test.tsx`, `OllamaQuantShelf.test.tsx`, detached-selector tests).

**Rust**: `cargo test` additions pinning `device_by_quantization` per engine-kind/quant and the largest-GPU comfortable fix.

## Critical Files for Implementation
- `src/entities/system-resources/lib/fit-assessor.ts` (byte model, pools, constants to reuse)
- `src-tauri/src/winstt/stt/quant_resolve.rs` (device pin matrix + auto-quant to mirror/expose)
- `src/widgets/model-picker/stt/lib/filter-state.ts` (existing filter path + the pool bug to fix)
- `src/features/connect-server/lib/runtime-model-breakdown.ts` (per-modality committed-memory assembly to mirror)
- `src/widgets/model-picker-window/ui/PickerBody.tsx` (host wiring for all three local pickers)

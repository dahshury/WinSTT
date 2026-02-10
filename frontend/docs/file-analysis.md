# Top 10 Largest Files - Refactoring Analysis

**Generated**: 2026-02-10
**Command Run**: `tokei frontend/ -f -s code`
**Scope**: `frontend/` — Electron + Next.js 16 + FSD architecture

---

## TypeScript

| Rank | File Path | Responsibilities | LOC | DRY | SoC | Mod | Avg | Effort | Priority Score | Key Refactoring Needs |
| ---- | --------- | ---------------- | --- | --- | --- | --- | --- | ------ | -------------- | --------------------- |
| 1 | `electron/ipc/hotkey.ts` | Global hotkey detection via uiohook-napi; keycode mapping, combo parsing, recording mode | 353 | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | 3.3 | 🟢 Low | 6.7 | Extract 124-line keycode data table and reset-state helper |
| 2 | `electron/ipc/relay.ts` | Event relay from STT WebSocket to renderer; post-processing (dictionary, snippets); model catalog cache | 223 | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | 3.3 | 🟢 Low | 6.7 | Extract post-processing and model catalog cache into separate modules |
| 3 | `electron/ws/stt-client.ts` | Dual-channel WebSocket client with reconnection, request-response timeouts, and event emission | 249 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 4.0 | 🟢 Low | 6.0 | Extract request-with-timeout helper; deduplicate socket cleanup |
| 4 | `electron/ipc/stt-process.ts` | STT server subprocess lifecycle: settings→CLI args, spawn/kill, auto-spawn at startup | 192 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 4.0 | 🟢 Low | 6.0 | Minor: extract repeated error-state reset pattern |
| 5 | `src/shared/api/ipc-client.ts` | Typed IPC facade for renderer; wraps window.electronAPI with channel-specific typed functions | 145 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 4.3 | 🟢 Low | 5.7 | Create a typed `onTyped<T>()` helper to reduce boilerplate in 20+ event subscriptions |
| 6 | `electron/main.ts` | Electron entry point: window creation, IPC registration, CSP, STT command proxy, GPU/audio device enumeration | 465 | ⭐⭐⭐ | ⭐⭐ | ⭐⭐ | 2.3 | 🟡 Medium | 5.1 | Extract STT command proxy, loopback, dialog, and audio-device enumeration into IPC modules |
| 7 | `src/features/update-settings/api/use-sync-settings.ts` | Bidirectional settings sync: Zustand ↔ electron-store ↔ STT server; debounced persistence | 188 | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | 2.7 | 🟡 Medium | 4.9 | Deduplicate syncAll/syncChanged; extract server-sync service from React hook |

---

## TSX

| Rank | File Path | Responsibilities | LOC | DRY | SoC | Mod | Avg | Effort | Priority Score | Key Refactoring Needs |
| ---- | --------- | ---------------- | --- | --- | --- | --- | --- | ------ | -------------- | --------------------- |
| 1 | `src/widgets/general-settings/ui/GeneralSettingsPanel.tsx` | General settings UI: language, recording mode, loopback, sound file D&D, startup toggles | 295 | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | 3.0 | 🟢 Low | 7.0 | Extract loopback device hook and sound-file drop handler into features |
| 2 | `src/features/audio-visualizer/ui/WaveformBars.tsx` | Canvas-based animated waveform visualizer with multi-layer sine waves and smoothed amplitude | 239 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 4.0 | 🟢 Low | 6.0 | Deduplicate drawWavePath and drawFilledRegion's shared iteration loop |
| 3 | `src/widgets/model-settings/ui/ModelSettingsPanel.tsx` | Model settings UI: main/realtime model, language, compute type, device, beam size | 212 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 4.0 | 🟢 Low | 6.0 | Minor: move buildModelOpts/buildRealtimeOpts to model-catalog entity lib |

---

## Detailed Analysis

### 1. `electron/main.ts` (465 LOC) - TypeScript - Electron Main Process

**Responsibilities**: Electron main process entry point. Creates the main and settings windows, registers all IPC handlers, configures Content Security Policy, proxies STT commands to WebSocket, queries GPU info via nvidia-smi, enumerates audio capture devices via PowerShell/C# COM interop, manages loopback and dialog handlers.

**Purpose**: Serves as the orchestration hub for the desktop application. Every IPC handler, window lifecycle event, and external process interaction originates here.

**Why It Exists**: Electron requires a single main process entry point. This file bootstraps the entire application lifecycle from a cold start through to graceful shutdown.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐ — `webPreferences` block duplicated between `createWindow` (L423-429) and `createSettingsWindow` (L357-362). The `!sttClient.isConnected` guard repeats 5× across `setupSttCommandHandlers` and `setupLoopbackHandlers`.
- SoC Violations: ⭐⭐ — Four distinct concerns are mixed: (1) window management, (2) STT command proxying, (3) GPU/audio device enumeration, (4) loopback/dialog handlers. The 90-line inline PowerShell C# script (L177-268) for audio device enumeration is a major embedded concern.
- Modularity Violations: ⭐⭐ — While hotkey, relay, settings, and stt-process have been extracted to their own IPC modules, `setupSttCommandHandlers` (60 LOC), `setupLoopbackHandlers` (25 LOC), `setupDialogHandlers` (15 LOC), and audio device enumeration (120 LOC) remain inline. The file depends on 6 internal modules and 3 Electron APIs.

**Refactoring Effort**: 🟡 Medium (3-4 days) — Large file with many inline handlers, but each extraction is independent. The audio device enumeration needs careful testing on Windows. No other files depend on the inline functions.

**Analysis**:

The file has been partially modularized — hotkey, relay, settings, file-transcribe, and stt-process are already in separate `electron/ipc/*.ts` modules. However, the remaining inline handlers (`setupSttCommandHandlers`, `setupLoopbackHandlers`, `setupDialogHandlers`) and the massive audio device enumeration block still inflate the file.

The most problematic section is the 90-line inline PowerShell/C# script for audio device enumeration via MMDevice COM interfaces. This should be its own module (e.g., `electron/lib/audio-devices.ts`) or even a standalone script file. The GPU detection via `nvidia-smi` (15 LOC) is also an infrastructure concern that doesn't belong in main.ts.

The webPreferences duplication between main window and settings window could be extracted to a shared config object. The `!sttClient.isConnected` guards could use a helper method that returns early.

**Critical Refactoring Blocks**:

1. **Lines 127-292** (165 LOC)
   - Issue: SoC — `setupSttCommandHandlers`, `setupLoopbackHandlers`, GPU detection, and audio device enumeration are all inline in main.ts
   - Suggestion: Extract to `electron/ipc/stt-commands.ts`, `electron/ipc/loopback.ts`, `electron/lib/gpu-info.ts`, and `electron/lib/audio-devices.ts`

2. **Lines 170-291** (120 LOC)
   - Issue: SoC/Modularity — Inline PowerShell C# COM interop script for audio device enumeration
   - Suggestion: Extract to `electron/lib/audio-devices.ts` as an async function; consider caching results

3. **Lines 347-398** (50 LOC)
   - Issue: DRY — `createSettingsWindow` duplicates `webPreferences` from `createWindow`
   - Suggestion: Extract shared `webPreferences` config to a constant

---

### 2. `electron/ipc/hotkey.ts` (353 LOC) - TypeScript - Hotkey System

**Responsibilities**: Global hotkey detection using uiohook-napi. Maps native keycodes to human-readable names, parses accelerator strings, detects combo key presses, and supports a recording mode for users to define custom hotkey combos.

**Purpose**: Provides system-wide (non-focused) hotkey detection that works regardless of which application has focus, critical for push-to-talk functionality.

**Why It Exists**: Electron's built-in `globalShortcut` API is too limited (no raw keycode access, no recording mode). uiohook-napi provides low-level keyboard hooks needed for PTT.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐ — The recording state reset pattern (`isRecording = false; recordingPressed.clear(); peakSnapshot = []`) appears 3× (L244-246, L365-367, L371-373). The `recordingSend("hotkey:recording-done", ...)` call appears twice with near-identical structure.
- SoC Violations: ⭐⭐⭐⭐ — Well-focused on hotkey detection. The 124-line keycode mapping table is data (not logic), but it's inherently coupled to this module's concern.
- Modularity Violations: ⭐⭐⭐ — The 124-line keycode mapping table (L10-133) bloats the file. `parseAccelerator` and `sortKeycodes` are pure functions that could be separately tested. The recording state machine is embedded in closure variables rather than an explicit state object.

**Refactoring Effort**: 🟢 Low (1-2 days) — The keycode map is a simple extraction. The state reset deduplication is mechanical. No external files depend on internals.

**Analysis**:

The file is well-focused on a single domain (hotkey detection) but is inflated by a 124-line keycode-to-name data table. This table is effectively a constant mapping that changes infrequently and could live in its own `keycodes.ts` module, making the business logic easier to read.

The recording mode state management uses 5 closure variables (`isRecording`, `recordingPressed`, `peakSnapshot`, `recordingSender`, and the implicit state transitions). A small `RecordingState` object with a `reset()` method would eliminate the 3× repeated cleanup pattern and make the state machine more explicit.

The main hotkey detection logic (onKeyDown/onKeyUp, checkCombo, activation/deactivation) is clean and well-commented. The `comboFullyReleased` guard prevents rapid re-triggering, which is a nice UX detail.

**Critical Refactoring Blocks**:

1. **Lines 10-133** (124 LOC)
   - Issue: Modularity — Large data table mixed with business logic
   - Suggestion: Extract `KEYCODE_TO_NAME`, `NAME_TO_KEYCODE`, and `MODIFIER_ORDER` to `electron/lib/keycodes.ts`

2. **Lines 235-262, 288-301, 361-377** (~50 LOC)
   - Issue: DRY — Recording state reset repeated 3×; `recordingSend("hotkey:recording-done", ...)` duplicated
   - Suggestion: Create a `resetRecording()` helper and a `finalizeRecording(combo: string | null)` helper

3. **Lines 190-394** (200 LOC)
   - Issue: Modularity — `setupHotkeyHandlers` is a 200-line function with 5 closure state variables
   - Suggestion: Consider a `HotkeyManager` class or explicit state object to make the state machine testable

---

### 3. `src/widgets/general-settings/ui/GeneralSettingsPanel.tsx` (295 LOC) - TSX - General Settings

**Responsibilities**: Renders the general settings panel with sections for language, recording mode (PTT/toggle/listen), loopback device selection, recording sound file (with drag-and-drop), file transcription format, and startup options (autostart, start minimized, minimize to tray).

**Purpose**: Primary configuration surface for non-model, non-quality settings. Users interact with this panel to customize their core experience.

**Why It Exists**: FSD architecture requires widget-level composition of features and entities for settings panels rendered by the settings page.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐ — Three identical Toggle setting patterns (L306-323) for autoStart, startMinimized, minimizeToTray: each is `<FormControl caption={...} label={...}><Toggle checked={...} onCheckedChange={(v) => update({...})} /></FormControl>`. Could use a data-driven approach.
- SoC Violations: ⭐⭐⭐ — Data fetching (loopback devices via IPC, audio duration validation) is mixed with UI rendering. The drag-and-drop sound file logic (30 LOC) includes file validation that could be a separate hook.
- Modularity Violations: ⭐⭐⭐ — The loopback device fetching effect (L75-104) and sound file D&D logic (L109-169) are inlined. These could be extracted to hooks (`useLoopbackDevices`, `useSoundFileDrop`), making the component purely declarative.

**Refactoring Effort**: 🟢 Low (1-2 days) — Extract two custom hooks. No architectural changes needed. Component stays in the same widget.

**Analysis**:

This is a large settings panel that handles 6 distinct setting groups in one component. While each group is visually separated by `<SettingSection>`, the component has accumulated data-fetching and validation logic that could be pushed into hooks or features.

The loopback device fetching (30 LOC) is an async IPC call with state management for options and default selection. This is a self-contained data concern that would benefit from being a `useLoopbackDevices()` hook. Similarly, the sound file drag-and-drop logic (60 LOC including handlers) validates file extension, duration, and manages drag state — a perfect candidate for `useSoundFileDrop()`.

The three toggle settings at the bottom (autoStart, startMinimized, minimizeToTray) are identical in structure. While not a severe DRY violation (each is only 5 LOC), a data-driven approach mapping `[{ key, label, caption, default }]` → `Toggle` components would reduce repetition and make adding new toggles trivial.

**Critical Refactoring Blocks**:

1. **Lines 75-104** (30 LOC)
   - Issue: SoC — Loopback device fetching with state management inlined in UI component
   - Suggestion: Extract to `useLoopbackDevices()` hook returning `{ options, currentId, handleChange }`

2. **Lines 109-169** (60 LOC)
   - Issue: SoC/Modularity — Sound file drag-and-drop with duration validation and error state
   - Suggestion: Extract to `useSoundFileDrop()` hook returning `{ dragOver, dropError, handlers }`

3. **Lines 303-325** (22 LOC)
   - Issue: DRY — Three identical Toggle + FormControl patterns for startup settings
   - Suggestion: Define a `toggleSettings` array and map over it, or accept as reasonable given it's only 3 items

---

### 4. `electron/ws/stt-client.ts` (249 LOC) - TypeScript - WebSocket Client

**Responsibilities**: Dual-channel WebSocket client (control + data) for STT server communication. Manages connection lifecycle with auto-reconnection (exponential backoff), request-response pattern with timeouts, and event emission for status/data events.

**Purpose**: Abstracts all WebSocket communication with the Python STT backend behind a clean event-emitter interface.

**Why It Exists**: The STT server uses two WebSocket channels (JSON control + binary data). This client encapsulates the dual-channel complexity and provides reconnection resilience.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐ — `getParameter()` (L143-161) and `listLoopbackDevices()` (L171-188) share an identical request-with-timeout pattern (create ID, set timer, store pending, send command). The socket cleanup pattern (`controlWs?.close(); dataWs?.close(); controlWs = null; dataWs = null`) appears 3× (L53-56, L128-131, L220-223).
- SoC Violations: ⭐⭐⭐⭐⭐ — Single well-defined concern: WebSocket client with reconnection.
- Modularity Violations: ⭐⭐⭐⭐ — Well-encapsulated class with clean public API. The request-with-timeout pattern could be a private helper. The generation counter (`_gen`) for handling stale callbacks is elegant.

**Refactoring Effort**: 🟢 Low (0.5-1 day) — Extract one helper method and one cleanup method. No external impact.

**Analysis**:

This is one of the better-structured files in the codebase. The `SttClient` class has a clean public API (`connect`, `disconnect`, `setParameter`, `getParameter`, `callMethod`, `isConnected`) and uses the EventEmitter pattern idiomatically.

The main DRY issue is the request-with-timeout pattern duplicated between `getParameter` and `listLoopbackDevices`. Both methods create a `requestId`, set up a timeout that rejects after `REQUEST_TIMEOUT_MS`, store in `pendingRequests`, and send a control command. A private `sendRequest(command: string, extraFields?: Record<string, unknown>): Promise<unknown>` would eliminate this duplication and make adding new request types trivial.

The socket cleanup pattern (`close both, null both`) appears three times. A private `closeAll()` method would clean this up.

**Critical Refactoring Blocks**:

1. **Lines 143-188** (45 LOC)
   - Issue: DRY — `getParameter` and `listLoopbackDevices` share identical request-with-timeout logic
   - Suggestion: Extract `private sendRequest(command: string, fields?: Record<string, unknown>): Promise<unknown>`

2. **Lines 53-56, 128-131, 220-223** (12 LOC)
   - Issue: DRY — Socket close+null pattern repeated 3×
   - Suggestion: Extract `private closeAll(): void`

---

### 5. `src/features/audio-visualizer/ui/WaveformBars.tsx` (239 LOC) - TSX - Audio Visualizer

**Responsibilities**: Canvas-based animated waveform with multi-layer sine waves. Smoothly interpolates amplitude and activity level based on recording state and audio levels. Renders a mirrored wave pair with gradient fills.

**Purpose**: Provides visual feedback during speech-to-text recording — the waveform responds to audio level, VAD state, and transcription events.

**Why It Exists**: A visual indicator that the app is actively listening and processing speech is essential UX for a dictation tool.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐ — `drawWavePath` (L69-92) and the first loop of `drawFilledRegion` (L106-115) both iterate `RESOLUTION` points calling `computeWaveY` and building a path. The path-building logic could be shared.
- SoC Violations: ⭐⭐⭐⭐⭐ — Entirely focused on waveform rendering. Constants, wave math, rendering helpers, and the component are cleanly separated within the file.
- Modularity Violations: ⭐⭐⭐⭐ — All rendering functions are pure and stateless. The component itself is well-memoized. The wave math could be unit-tested if extracted.

**Refactoring Effort**: 🟢 Low (0.5 day) — The path-building deduplication is straightforward. Optionally extract wave math for testing.

**Analysis**:

This file is well-organized with clear sections: tuning constants, wave layer definitions, rendering helpers, and the component. The separation of `computeRenderParams` (pure function deriving render state from audio state) from `drawFrame` (pure rendering) is clean.

The main duplication is between `drawWavePath` and `drawFilledRegion`. Both iterate `RESOLUTION` points and call `computeWaveY` to build a canvas path. `drawFilledRegion` does this twice (once for the top wave, once for the mirrored bottom). A shared `buildWavePath(ctx, w, h, time, amplitude, mirror)` helper that only builds the path (without stroke/fill) would reduce redundancy.

The `makeStrokeGradient` function is called 3× with slightly different alpha values. This is fine — the repetition is in the caller, not the function itself.

**Critical Refactoring Blocks**:

1. **Lines 69-92 vs 106-122** (40 LOC)
   - Issue: DRY — Two separate loops over `RESOLUTION` points building canvas paths from `computeWaveY`
   - Suggestion: Extract a shared `buildPathPoints(w, h, time, amplitude): [x, y][]` or refactor `drawFilledRegion` to reuse `drawWavePath` internally

2. **Lines 59-157** (100 LOC)
   - Issue: Modularity — All rendering helpers are pure functions with no dependencies, ideal for extraction to a `wave-math.ts` module for separate testing
   - Suggestion: Move to `features/audio-visualizer/lib/wave-renderer.ts` if the file continues to grow

---

### 6. `electron/ipc/relay.ts` (223 LOC) - TypeScript - Event Relay

**Responsibilities**: Bridges STT WebSocket events to renderer IPC channels. Applies post-processing (dictionary replacements, snippet expansion, sentence punctuation) to transcribed text. Caches model catalog and server-ready state for late-mounting renderers.

**Purpose**: The relay is the central nervous system connecting the STT backend to the UI. It translates server events into renderer-friendly IPC messages and handles text post-processing.

**Why It Exists**: The renderer has zero WebSocket code (by design). The relay module in the main process forwards all STT events through IPC, applying text transformations before delivery.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐⭐ — Minimal duplication. The switch statement cases are each unique despite following a similar `safeSend` pattern. This is inherent to event routing.
- SoC Violations: ⭐⭐⭐ — Three concerns are mixed: (1) event routing/relay, (2) text post-processing (dictionary, snippets, punctuation), (3) state caching (model catalog, server-ready flag). The post-processing logic (60 LOC) is a distinct text transformation concern.
- Modularity Violations: ⭐⭐⭐ — The `setupRelay` function has a clean interface, but the module-level state (`cachedModelCatalog`, `serverIsReady`, `cachedDictPatterns`, `cachedSnippets`) and the IPC handles registered at module load time (`ipcMain.handle` on L15, L19) create implicit coupling.

**Refactoring Effort**: 🟢 Low (1-2 days) — Extract post-processing to a separate module. Move catalog cache to a shared state module.

**Analysis**:

The relay function itself is clean — it subscribes to `SttClient` events and forwards them via IPC. The switch statement (L115-198) is straightforward event routing with appropriate field mapping (e.g., `event.downloaded_bytes` → `downloadedBytes`).

The post-processing logic (L24-90) is the main SoC issue. `rebuildDictPatterns()`, `rebuildSnippets()`, and `applyPostProcessing()` are pure text transformation functions that have nothing to do with event relay. They should live in their own module (e.g., `electron/lib/text-processing.ts`), making both concerns independently testable.

The module-level IPC handles for `stt:get-model-catalog` and `stt:get-server-ready` (L15, L19) are registered as side effects on import, which is fragile. They should be part of `setupRelay` or a dedicated setup function.

**Critical Refactoring Blocks**:

1. **Lines 24-90** (66 LOC)
   - Issue: SoC — Post-processing (dictionary regex compilation, snippet expansion, sentence punctuation) mixed with event relay
   - Suggestion: Extract to `electron/lib/text-processing.ts` with `compilePatterns(store)`, `applyPostProcessing(text): string`

2. **Lines 8-19** (12 LOC)
   - Issue: Modularity — Module-level state and IPC handles registered as import side effects
   - Suggestion: Move `cachedModelCatalog`, `serverIsReady`, and their IPC handles into `setupRelay` or a dedicated `setupCatalogCache()`

3. **Lines 115-198** (83 LOC)
   - Issue: Minor DRY — Event routing switch has many similar `safeSend(channel, payload)` arms
   - Suggestion: Acceptable as-is; a data-driven approach would sacrifice readability for minimal LOC reduction

---

### 7. `src/widgets/model-settings/ui/ModelSettingsPanel.tsx` (212 LOC) - TSX - Model Settings

**Responsibilities**: Renders the model settings panel with sections for main model selection, language, compute type, device, beam size, and realtime model configuration. Builds grouped model options from the server's model catalog.

**Purpose**: Configuration surface for Whisper model selection, language, and inference parameters. Adapts UI based on model backend (Whisper vs NeMo).

**Why It Exists**: FSD widget that composes entities (model-catalog) and features (update-settings, connect-server) for the settings page.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐⭐ — `buildModelOpts` and `buildRealtimeOpts` share grouping logic, but `buildRealtimeOpts` correctly delegates to `buildModelOpts` with a filter. The repeated `<FormControl><Select/NumberStepper/SearchableSelect /></FormControl>` pattern is inherent to settings panels.
- SoC Violations: ⭐⭐⭐⭐ — Clear primary concern (model settings UI). Data transformation (`buildModelOpts`, `COMPUTE_LABELS`) is minor and closely related.
- Modularity Violations: ⭐⭐⭐⭐ — Good use of shared UI components and entity stores. `buildModelOpts` could live in the model-catalog entity's `lib/` segment.

**Refactoring Effort**: 🟢 Low (0.5 day) — Move helper functions to entity lib. No structural changes.

**Analysis**:

This is a well-structured settings panel component. The model option building logic (`buildModelOpts`, `buildRealtimeOpts`) is cleanly separated as top-level pure functions. The component correctly uses `useMemo` for computed options and `useCallback` for event handlers.

The conditional rendering based on `isWhisperBackend` (hiding compute type and beam size for non-Whisper models) is a nice UX detail. The device options correctly adapt to GPU availability.

The only meaningful improvement would be moving `buildModelOpts`, `buildRealtimeOpts`, and `FAMILY_LABELS` to the model-catalog entity's `lib/` segment, since they're purely about transforming `ModelInfo[]` into `SelectOption[]`.

**Critical Refactoring Blocks**:

1. **Lines 24-77** (53 LOC)
   - Issue: Modularity — `COMPUTE_LABELS`, `buildModelOpts`, `buildRealtimeOpts`, `FAMILY_LABELS` are model-catalog domain logic in a widget
   - Suggestion: Move to `entities/model-catalog/lib/model-options.ts` and re-export from entity's public API

---

### 8. `electron/ipc/stt-process.ts` (192 LOC) - TypeScript - STT Process Manager

**Responsibilities**: Manages the STT server subprocess. Maps electron-store settings to CLI arguments, resolves the server directory and executable path, spawns/kills the Python process, handles auto-spawn at startup, and exposes IPC handlers for renderer-triggered spawn/kill/status.

**Purpose**: Provides lifecycle management for the bundled Python STT server, handling both development (uv run) and production (PyInstaller exe) environments.

**Why It Exists**: The desktop app needs to manage the STT server as a child process. This module encapsulates the spawn configuration, process monitoring, and graceful termination.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐⭐ — Minor: `status = "error"; sttProcess = null;` appears 3× (L186-187, L207-208, L252-253). The `SETTINGS_TO_CLI` and `BOOLEAN_OPTIONAL_CLI` mappings are well-structured data tables with no duplication.
- SoC Violations: ⭐⭐⭐⭐ — Single, well-defined concern: subprocess lifecycle. Settings-to-CLI mapping is inherently part of process spawning.
- Modularity Violations: ⭐⭐⭐⭐ — Clean exports (`setupSttProcessHandlers`, `killSttProcess`, `restartSttProcess`, `tryAutoSpawnServer`, `isSttProcessRunning`). Internal functions are well-decomposed (`buildServerArgs`, `resolveServerDir`, `resolveSpawnArgs`, `attachProcessHandlers`).

**Refactoring Effort**: 🟢 Low (0.5 day) — Only minor cleanup needed. Already well-structured.

**Analysis**:

This is one of the best-structured files in the codebase. The settings-to-CLI mapping is cleanly expressed as data tables (`SETTINGS_TO_CLI`, `BOOLEAN_OPTIONAL_CLI`) rather than imperative code. The spawn logic correctly handles both development (uv run) and production (PyInstaller) environments.

The `attachProcessHandlers` function uses a captured `proc` reference to prevent stale exit/error handlers from clobbering a newly spawned replacement — a subtle but important correctness detail.

The only DRY issue is the repeated error-state-reset pattern. A small `setError()` helper would eliminate the repetition: `function setError() { status = "error"; sttProcess = null; }`.

**Critical Refactoring Blocks**:

1. **Lines 186-187, 207-208, 252-253** (6 LOC)
   - Issue: DRY — `status = "error"; sttProcess = null;` repeated 3×
   - Suggestion: Extract to `function setErrorState(): void { status = "error"; sttProcess = null; }`

---

### 9. `src/features/update-settings/api/use-sync-settings.ts` (188 LOC) - TypeScript - Settings Sync

**Responsibilities**: Bidirectional settings synchronization between the Zustand store, electron-store (via IPC), and the STT server (via `sttSetParameter`). Handles initial hydration from electron-store, cross-window broadcast coordination, debounced persistence, and server-status-dependent bulk sync.

**Purpose**: Ensures settings state is consistent across three systems (React store, persistent storage, server parameters) with minimal latency and no circular sync loops.

**Why It Exists**: Settings can change from multiple sources (user edits, tray menu, other windows) and must propagate to the STT server in real-time for hot-reloadable parameters while persisting to disk.

**Violation Scores**:

- DRY Violations: ⭐⭐ — `syncAllToServer` (L26-56) and `syncChangedToServer` (L86-115) both iterate `AUDIO_PARAM_MAP`, handle language/model, and deal with smart endpoint logic. The endpoint sync in `syncEndpointChanges` (L59-83) partially duplicates `syncAllToServer`'s endpoint handling (L46-55). Three separate functions handle overlapping parameter sets.
- SoC Violations: ⭐⭐⭐ — The hook manages three concerns: (1) electron-store persistence, (2) server parameter sync, (3) cross-window broadcast coordination. Six `useRef`s track various state flags, making the hook complex to reason about.
- Modularity Violations: ⭐⭐⭐ — Server sync logic (`syncAllToServer`, `syncChangedToServer`, `syncEndpointChanges`) is framework-agnostic and could be a plain TypeScript module. The React hook should only handle the lifecycle orchestration (effects, refs), not the sync business logic.

**Refactoring Effort**: 🟡 Medium (2-3 days) — The sync logic is intertwined with React lifecycle. Extracting it requires careful preservation of the debounce, broadcast-skip, and hydration-skip behaviors. Testing the extracted sync service independently would add confidence.

**Analysis**:

This is the most complex file by accidental complexity. The 6 refs (`prevRef`, `loadedOnceRef`, `debounceRef`, `latestSettingsRef`, `hasSyncedOnConnect`, `fromBroadcastRef`, `fromIpcLoadRef`) track a state machine that's implicit rather than explicit. Each `useEffect` has careful guards to prevent circular sync loops, and the interaction between them is non-obvious.

The duplication between `syncAllToServer` and `syncChangedToServer` is the primary DRY concern. Both functions need to handle the same set of parameters (audio, language, model, endpoints) but one applies all values unconditionally while the other diffs against the previous state. A unified approach — a `syncParameters(settings, prev?)` function that syncs all when `prev` is undefined, or only changed parameters when `prev` is provided — would eliminate this duplication.

The `syncEndpointChanges` function adds a third layer of complexity. The smart endpoint and silence_timing logic appears in both `syncAllToServer` (L46-55) and `syncEndpointChanges` (L59-83) with subtle differences in how they check for changes.

**Critical Refactoring Blocks**:

1. **Lines 26-56 vs 86-115** (75 LOC)
   - Issue: DRY — `syncAllToServer` and `syncChangedToServer` iterate the same parameter maps with similar logic
   - Suggestion: Unify into `syncParameters(settings: AppSettings, prev?: AppSettings)` — if prev is undefined, sync all; otherwise, sync only changed

2. **Lines 59-83** (25 LOC)
   - Issue: DRY — `syncEndpointChanges` partially duplicates endpoint handling from `syncAllToServer`
   - Suggestion: Merge into the unified `syncParameters` function above

3. **Lines 117-238** (120 LOC)
   - Issue: SoC/Modularity — React hook manages too many concerns with 6 refs
   - Suggestion: Extract server sync to `lib/sync-to-server.ts` and persistence to `lib/sync-to-store.ts`; the hook becomes a thin orchestrator

---

### 10. `src/shared/api/ipc-client.ts` (145 LOC) - TypeScript - IPC Client Facade

**Responsibilities**: Typed IPC client for the renderer process. Wraps `window.electronAPI` with channel-specific functions for all IPC operations: STT commands, hotkey, settings, window controls, event subscriptions, file transcription, and loopback control.

**Purpose**: Provides a type-safe, importable API surface for renderer code to communicate with the Electron main process without touching IPC channels directly.

**Why It Exists**: FSD's shared/api layer. Centralizes all IPC communication behind typed functions, preventing raw channel string usage in features/widgets.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐ — The `on(IPC.CHANNEL, (data) => cb((data as { key: Type }).key))` pattern repeats ~20 times (L97-158). Each instance manually casts `data` and extracts a specific field. A typed helper like `onTyped<T>(channel, extractor, cb)` would eliminate this boilerplate.
- SoC Violations: ⭐⭐⭐⭐⭐ — Single, well-defined concern: typed IPC facade. No business logic, no side effects beyond IPC.
- Modularity Violations: ⭐⭐⭐⭐⭐ — Excellent modularity. Each function is independently importable. Clean dependency on `ipc-channels.ts` for channel constants. The `isElectron()` guard provides graceful degradation outside Electron.

**Refactoring Effort**: 🟢 Low (0.5 day) — Create a typed helper function. Mechanical transformation of existing patterns.

**Analysis**:

This file is a well-organized API facade that follows the FSD shared/api convention. Every IPC channel has a corresponding typed function, and the naming is consistent (`onRealtimeText`, `onFullSentence`, `onRecordingStart`).

The main improvement opportunity is the repetitive event subscription pattern. Currently, each `on*` function manually casts the incoming `unknown` data to a specific shape and extracts a field. A typed helper would reduce this:

```typescript
function onTyped<T>(channel: string, extract: (data: unknown) => T, cb: (value: T) => void) {
    return on(channel, (data) => cb(extract(data)));
}
```

This would turn 3-line subscription functions into 1-liners. However, this is a low-priority improvement — the current code is correct, readable, and the type casts serve as documentation of the IPC contract.

**Critical Refactoring Blocks**:

1. **Lines 97-158** (60 LOC)
   - Issue: DRY — ~20 event subscription functions with identical `on(IPC.X, (data) => cb((data as T).field))` pattern
   - Suggestion: Create `onTyped<T, R>(channel, extractor: (d: unknown) => R, cb: (r: R) => void)` helper; reduces each subscription to a single line

---

## Summary

### Overall Health

The frontend codebase is in **good shape** overall. Most files score ⭐⭐⭐ to ⭐⭐⭐⭐ across all three axes. The architecture follows FSD conventions in the renderer and has been partially modularized in Electron's main process.

### Top 3 Priority Refactoring Items

1. **`GeneralSettingsPanel.tsx`** (Score: 7.0) — Extract `useLoopbackDevices()` and `useSoundFileDrop()` hooks. Low effort, high readability improvement.

2. **`hotkey.ts`** (Score: 6.7) — Extract the 124-line keycode map to `electron/lib/keycodes.ts` and add a recording-state reset helper. Low effort, reduces file by 35%.

3. **`relay.ts`** (Score: 6.7) — Extract post-processing to `electron/lib/text-processing.ts` and move catalog cache into `setupRelay`. Low effort, cleanly separates relay routing from text transformation.

### Deferred Items

- **`main.ts`** (Score: 5.1) — Worst violation scores but Medium effort. The inline PowerShell/C# device enumeration is the biggest win; STT command extraction is mechanical but touches many concerns.

- **`use-sync-settings.ts`** (Score: 4.9) — Most complex accidental complexity but Medium effort due to intertwined React lifecycle. Best addressed when the sync logic needs to change next.

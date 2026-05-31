/**
 * Pure helpers extracted from use-sync-settings for testability.
 *
 * These functions contain the branchy logic that drives CRAP scores in the
 * hook. Keeping them pure (no ref-reads, no IPC calls) makes them trivially
 * unit-testable.
 */

import { decodeSettingsPayload } from "@/shared/api/settings-codec";
import type { AppSettingsOutput as AppSettings } from "@/shared/config/settings-schema";

/** True when a parameter must be sent on an initial (post-connect) flush. */
export function shouldSendInitial(value: unknown): boolean {
	return value != null;
}

/** True when a parameter must be sent on an incremental update. */
export function shouldSendOnChange<V>(
	value: V | undefined | null,
	prevValue: V | undefined | null
): boolean {
	return value !== prevValue;
}

/**
 * True when the recording mode short-circuits all silence-driven endpoint
 * detection (PTT: key release defines the boundary; toggle+manualToggleStop:
 * second press defines the boundary). CC 3 — one ternary, one short-circuit.
 */
function silenceEndpointBypassed(mode: string, manualToggleStop = false): boolean {
	return mode === "ptt" || (mode === "toggle" && manualToggleStop);
}

/** True when the mode implies a continuously-listening pipeline (CC 2). */
function modeImpliesContinuousListening(mode: string): boolean {
	return mode === "toggle" || mode === "listen";
}

/**
 * Whether the STT "silence_timing" flag should be active.
 * PTT defines the boundary with the key release, so Smart Endpoint never
 * applies there. Otherwise: on when smart endpoint is enabled or when the
 * recording mode implies continuous listening (toggle / listen).
 *
 * Manual-toggle mode explicitly opts out: the user wants press-to-press
 * with no silence-driven endpoint detection, so silence_timing must be
 * off even though the mode is `toggle`.
 */
export function computeSilenceTiming(
	smartEndpoint: boolean,
	mode: string,
	manualToggleStop = false
): boolean {
	if (silenceEndpointBypassed(mode, manualToggleStop)) {
		return false;
	}
	return smartEndpoint || modeImpliesContinuousListening(mode);
}

/**
 * Whether the STT "silence_endpoint_enabled" flag should be active.
 * Mirrors the silence-VAD stop policy:
 *   - PTT: off (the key release defines the boundary).
 *   - Toggle with manualToggleStop: off (the second press defines the boundary).
 *   - Otherwise: on (VAD silence ends the utterance).
 */
export function computeSilenceEndpointEnabled(mode: string, manualToggleStop = false): boolean {
	return !silenceEndpointBypassed(mode, manualToggleStop);
}

/** True when the recording mode changed (or this is the initial sync). */
function modeChanged(
	isInitial: boolean,
	recordingMode: string | undefined,
	prevRecordingMode: string | undefined
): boolean {
	return isInitial || recordingMode !== prevRecordingMode;
}

/**
 * Whether the silence_timing parameter needs to be re-sent after a settings
 * change.  True on initial connect, when the recording mode changed, when
 * the smart-endpoint toggle flipped, or when the manual-toggle-stop flag
 * flipped (since it gates silence_timing on/off in toggle mode).
 */
export function silenceTimingNeedsUpdate(
	smartEndpoint: boolean,
	prevSmartEndpoint: boolean,
	recordingMode: string | undefined,
	prevRecordingMode: string | undefined,
	isInitial: boolean,
	manualToggleStop = false,
	prevManualToggleStop = false
): boolean {
	if (modeChanged(isInitial, recordingMode, prevRecordingMode)) {
		return true;
	}
	return smartEndpoint !== prevSmartEndpoint || manualToggleStop !== prevManualToggleStop;
}

/**
 * Whether the silence_endpoint_enabled parameter needs to be re-sent.
 * True on initial connect, on recording-mode change, or when the
 * manual-toggle-stop flag flipped (toggle-mode behaviour pivots on it).
 */
export function silenceEndpointNeedsUpdate(
	recordingMode: string | undefined,
	prevRecordingMode: string | undefined,
	isInitial: boolean,
	manualToggleStop = false,
	prevManualToggleStop = false
): boolean {
	if (isInitial) {
		return true;
	}
	return recordingMode !== prevRecordingMode || manualToggleStop !== prevManualToggleStop;
}

/** Extract the manualToggleStop flag, defaulting to false. */
export function getManualToggleStop(settings: AppSettings): boolean {
	return settings.general?.manualToggleStop ?? false;
}

/** Extract the previous manualToggleStop flag, defaulting to false when prev is absent. */
export function getPrevManualToggleStop(prev: AppSettings | undefined): boolean {
	return prev?.general?.manualToggleStop ?? false;
}

/**
 * Returns true when the autoStart system setting has changed and the new
 * value is not null/undefined.
 */
export function autoStartChanged(settings: AppSettings, prev: AppSettings): boolean {
	return (
		settings.general?.autoStart !== prev.general?.autoStart && settings.general?.autoStart != null
	);
}

/**
 * If `ref.current` is true, reset it to false and return true (meaning "skip").
 * Otherwise return false.
 */
export function clearIfSet(ref: { current: boolean }): boolean {
	if (!ref.current) {
		return false;
	}
	ref.current = false;
	return true;
}

/**
 * Advance the "skip" ref state machine and return whether the caller should
 * skip the current settings-change cycle.
 *
 * Side effects: flips `loadedOnce.current`, `fromBroadcast.current`, or
 * `fromIpcLoad.current` as appropriate.
 */
export function advanceSkipRefs(refs: {
	loadedOnce: { current: boolean };
	fromBroadcast: { current: boolean };
	fromIpcLoad: { current: boolean };
}): boolean {
	if (!refs.loadedOnce.current) {
		refs.loadedOnce.current = true;
		return true;
	}
	return clearIfSet(refs.fromBroadcast) || clearIfSet(refs.fromIpcLoad);
}

/**
 * Whether a recording mode change occurred (triggers an immediate save rather
 * than a debounced one).
 */
export function isModeChanged(settings: AppSettings, prev: AppSettings): boolean {
	return settings.general?.recordingMode !== prev.general?.recordingMode;
}

/** Extract the smartEndpoint flag from settings, defaulting to true
 *  (matches the qualitySettingsSchema default — smart endpoint is ON by
 *  default to avoid finalizing mid-thought). */
export function getSmartEndpoint(settings: AppSettings): boolean {
	return settings.quality?.smartEndpoint ?? true;
}

/** Extract the previous smartEndpoint flag, defaulting to true when prev
 *  is absent (same default as getSmartEndpoint, so a first sync with no
 *  prior value doesn't register a spurious change). */
export function getPrevSmartEndpoint(prev: AppSettings | undefined): boolean {
	return prev?.quality?.smartEndpoint ?? true;
}

/** Extract the recording mode from settings, defaulting to "ptt". */
export function getRecordingMode(settings: AppSettings): string {
	return settings.general?.recordingMode ?? "ptt";
}

/**
 * Whether the initial settings sync to the STT server should be triggered.
 * True only when the server just became ready, settings are loaded FROM
 * ELECTRON-STORE (not just from the Zustand-persist localStorage cache),
 * and we haven't already synced in this session.
 *
 * The `fromIpcLoad` gate is load-bearing: `isLoaded` flips to `true` the
 * moment localStorage hydration completes (synchronous, during the store's
 * `create` call). That cached snapshot can be STALE relative to
 * electron-store — most commonly when the user changed `model.model` in a
 * previous session, the renderer wrote it through, but localStorage was
 * not updated for some reason (window force-killed before the persist
 * middleware flushed, dev-server hot reload during a write, …). Without
 * the IPC gate, the first `syncToServer` after connect re-asserts the
 * stale Zustand cache via `sttSetParameter("model", staleValue)`, the
 * server obediently swaps from its CLI-arg-loaded model to the stale
 * value, and the user sees "Switching to <stale>" loop until they
 * manually re-pick. The server was already spawned with the correct
 * disk value from electron-store (see `SETTINGS_TO_CLI` in
 * stt-process.ts), so the only "initial sync" worth doing is one that
 * reflects the same disk state.
 *
 * `fromIpcLoad` is set inside `useSyncSettings` the moment the
 * `settingsLoad()` IPC promise resolves with the disk snapshot, so this
 * gate buys us "wait one async tick for the canonical state before
 * touching the server." On a clean install where localStorage and disk
 * agree it adds at most a few milliseconds; on the divergent case it
 * prevents the spurious model-revert loop entirely.
 */
function isLiveServerReady(serverStatus: string, isLoaded: boolean): boolean {
	return serverStatus === "running" && isLoaded;
}

export function shouldSyncOnConnect(
	serverStatus: string,
	isLoaded: boolean,
	alreadySynced: boolean,
	fromIpcLoad: boolean
): boolean {
	return isLiveServerReady(serverStatus, isLoaded) && fromIpcLoad && !alreadySynced;
}

/**
 * Schedule a save of `settings` to electron-store, debouncing by `delayMs`
 * unless `immediate` is true (e.g. when the recording mode changed).
 *
 * Cancels any previously pending debounced save before scheduling the new one.
 * Returns the new timer ID (or null when `immediate` is true) so the caller
 * can store it for cancellation on cleanup.
 */
export function scheduleSave(
	settings: AppSettings,
	immediate: boolean,
	debounceRef: { current: ReturnType<typeof setTimeout> | null },
	saveFn: (s: AppSettings) => void,
	delayMs: number
): void {
	if (debounceRef.current) {
		clearTimeout(debounceRef.current);
	}
	if (immediate) {
		debounceRef.current = null;
		saveFn(settings);
	} else {
		debounceRef.current = setTimeout(() => {
			saveFn(settings);
			debounceRef.current = null;
		}, delayMs);
	}
}

/** Cheap structural equality. JSON.stringify is sufficient for the settings
 *  shape: every value is a primitive, plain object, or array of primitives /
 *  plain objects, and key ordering is stable across Zod parses on a given
 *  schema (it walks the shape definition in declaration order). */
function settingsSectionsEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merge a broadcast `settings:changed` payload with the current zustand state
 * so user-dirty top-level sections (those that differ from the last-saved
 * baseline) survive the broadcast.
 *
 * Without this, an unrelated save in another window (e.g. `useVadCalibration`
 * pushing a new silero sensitivity) lands at the settings panel right in the
 * middle of the 300ms debounce after the user clicked a toggle, the broadcast
 * `setSettings(decoded)` overwrites the just-clicked value with whatever the
 * broadcast snapshot had, and the resulting `[settings, isLoaded]` cleanup
 * cancels the pending save — silently discarding the click.
 *
 * Returns the merged settings plus a `preserved` flag indicating whether any
 * section was kept from `current`. Callers use the flag to decide whether to
 * mark `fromBroadcastRef` (pure broadcasts skip the next save effect) or let
 * the effect re-schedule a save for the merged state (so user-dirty fields
 * actually persist).
 *
 * Falls back to identity (use the broadcast) when there's no `lastSaved`
 * baseline yet — that's the path on the very first broadcast before
 * `settingsLoad` has resolved, where any local difference can't be
 * distinguished from "we haven't synced with disk yet" and accepting the
 * broadcast is the safer default.
 */
function pickSection(
	decodedValue: unknown,
	currentValue: unknown,
	lastSavedValue: unknown
): { value: unknown; preserved: boolean } {
	return settingsSectionsEqual(currentValue, lastSavedValue)
		? { value: decodedValue, preserved: false }
		: { value: currentValue, preserved: true };
}

function mergeSections(
	decoded: AppSettings,
	current: AppSettings,
	lastSaved: AppSettings
): { merged: AppSettings; preserved: boolean } {
	let preserved = false;
	const result: Record<string, unknown> = {};
	for (const [key, decodedValue] of Object.entries(decoded)) {
		const typedKey = key as keyof AppSettings;
		const picked = pickSection(decodedValue, current[typedKey], lastSaved[typedKey]);
		result[key] = picked.value;
		preserved = preserved || picked.preserved;
	}
	return { merged: result as AppSettings, preserved };
}

export function mergeBroadcastPreservingUserDirty(
	decoded: AppSettings,
	current: AppSettings,
	lastSaved: AppSettings | undefined
): { merged: AppSettings; preserved: boolean } {
	return lastSaved
		? mergeSections(decoded, current, lastSaved)
		: { merged: decoded, preserved: false };
}

/**
 * Pure projection of the broadcast handler in `useSyncSettings`. Decodes the
 * incoming snapshot, merges it against the local user-dirty state, and decides
 * whether the next render should mark `fromBroadcast` (so the save effect
 * doesn't echo the broadcast back to disk).
 *
 * Living here lets unit tests cover the handler without rendering the hook.
 */
export function deriveBroadcastUpdate(
	incoming: AppSettings,
	current: AppSettings,
	lastSaved: AppSettings | undefined,
	fromBroadcastNow: boolean
): { merged: AppSettings; nextFromBroadcast: boolean } {
	const decoded = decodeSettingsPayload(incoming);
	const { merged, preserved } = mergeBroadcastPreservingUserDirty(decoded, current, lastSaved);
	return { merged, nextFromBroadcast: !preserved || fromBroadcastNow };
}

/**
 * Pure helpers extracted from use-sync-settings for testability.
 *
 * These functions contain the branchy logic that drives CRAP scores in the
 * hook. Keeping them pure (no ref-reads, no IPC calls) makes them trivially
 * unit-testable.
 */

import type { AppSettingsSaveInput as AppSettings } from "@/shared/api/models";

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
 * Whether the STT "silence_timing" flag should be active.
 * True when smart endpoint is on, or when the recording mode implies
 * continuous listening (toggle / listen).
 */
export function computeSilenceTiming(smartEndpoint: boolean, mode: string): boolean {
	return smartEndpoint || mode === "toggle" || mode === "listen";
}

/**
 * Whether the silence_timing parameter needs to be re-sent after a settings
 * change.  True on initial connect, when the recording mode changed, or when
 * the smart-endpoint toggle flipped.
 */
export function silenceTimingNeedsUpdate(
	smartEndpoint: boolean,
	prevSmartEndpoint: boolean,
	recordingMode: string | undefined,
	prevRecordingMode: string | undefined,
	isInitial: boolean
): boolean {
	const modeChanged = isInitial || recordingMode !== prevRecordingMode;
	return modeChanged || smartEndpoint !== prevSmartEndpoint;
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

/** Extract the smartEndpoint flag from settings, defaulting to false. */
export function getSmartEndpoint(settings: AppSettings): boolean {
	return settings.quality?.smartEndpoint ?? false;
}

/** Extract the previous smartEndpoint flag, defaulting to false when prev is absent. */
export function getPrevSmartEndpoint(prev: AppSettings | undefined): boolean {
	return prev?.quality?.smartEndpoint ?? false;
}

/** Extract the recording mode from settings, defaulting to "ptt". */
export function getRecordingMode(settings: AppSettings): string {
	return settings.general?.recordingMode ?? "ptt";
}

/**
 * Whether the initial settings sync to the STT server should be triggered.
 * True only when the server just became ready, settings are loaded, and we
 * haven't already synced in this session.
 */
export function shouldSyncOnConnect(
	serverStatus: string,
	isLoaded: boolean,
	alreadySynced: boolean
): boolean {
	return serverStatus === "running" && isLoaded && !alreadySynced;
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

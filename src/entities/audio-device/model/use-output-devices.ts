import { useEffect, useSyncExternalStore } from "react";
import {
	type AudioOutputDevice,
	audioGetOutputDevices,
	audioRefreshOutputDevices,
	onAudioDeviceChangeDetected,
	onAudioOutputDevicesChanged,
} from "@/shared/api/ipc-client";
import { fireAndForget } from "@/shared/lib/fire-and-forget";

/**
 * One ``audiooutput`` device entry, denormalized from
 * :class:`MediaDeviceInfo` so the consumer doesn't have to depend on the
 * DOM type (which isn't available in unit tests without jsdom shims).
 */
export interface OutputDevice {
	deviceId: string;
	isDefault: boolean;
	label: string;
}

interface UseOutputDevicesResult {
	defaultDevice: OutputDevice | null;
	devices: OutputDevice[];
	refresh: () => Promise<void>;
	/**
	 * The browser ``MediaDeviceInfo.deviceId`` of every output sink the browser
	 * currently knows about (real, routable ids — the synthetic name-ids used for
	 * not-yet-resolved backend devices are excluded). Consumers that need to
	 * reconcile a SAVED browser deviceId (e.g. ``useDeviceSwitchFeedback`` resetting
	 * a vanished sink) must check against THIS, not ``devices`` — a backend device
	 * shown before its browser join resolves carries a synthetic id, so checking
	 * ``devices`` would spuriously treat a still-connected sink as gone.
	 */
	sinkIds: string[];
}

/**
 * Same debounce window as :file:`use-input-devices.ts` — bursty
 * ``devicechange`` events from drivers coalesce into one re-enumeration.
 */
const DEVICECHANGE_DEBOUNCE_MS = 200;

function areOutputDeviceListsEqual(
	a: readonly OutputDevice[],
	b: readonly OutputDevice[],
): boolean {
	return (
		a.length === b.length &&
		a.every((device, index) => {
			const other = b[index];
			return (
				other !== undefined &&
				device.deviceId === other.deviceId &&
				device.label === other.label &&
				device.isDefault === other.isDefault
			);
		})
	);
}

// ── Module-level state ────────────────────────────────────────────────────────
//
// Output devices have TWO sources that are merged into the published list:
//
//   1. `backendOutputDevices` — the AUTHORITATIVE membership (name + default),
//      pushed from Rust/cpal via `audio:output-devices-changed`. This is what
//      makes the picker update in real time on hot-plug: the native endpoint
//      watcher reliably detects the change, whereas the browser's own
//      `enumerateDevices()` cache lags (or never fires) for output devices
//      inside the embedded WebView2 — the exact reason inputs already enumerate
//      backend-side.
//
//   2. `browserSinkMap` — `normalizedLabel → MediaDeviceInfo.deviceId`, the only
//      place a usable `setSinkId`/`sinkId` id can come from (the backend can't
//      produce it). We JOIN the backend list to it by name so a device the
//      backend reports is routable as soon as the browser also knows it.
//
// When the backend list is empty (non-desktop, cpal failure, or the unit-test
// environment where the IPC invoke resolves to `[]`), we fall back to the pure
// browser-derived list so behaviour never regresses below "what the browser
// shows".
let outputDeviceCache: OutputDevice[] = [];
const outputDeviceSubscribers = new Set<() => void>();

let backendOutputDevices: AudioOutputDevice[] = [];
let browserSinkMap = new Map<string, string>();
let browserOutputDevices: OutputDevice[] = [];
let outputDeviceRefreshInFlight: Promise<void> | null = null;

// The set of real, routable browser sink ids (values of `browserSinkMap`),
// published separately so a saved-deviceId reconcile can compare against the
// browser's authority for browser-deviceId existence (see `sinkIds` doc above).
let browserSinkIdsCache: string[] = [];
const browserSinkIdsSubscribers = new Set<() => void>();

function publishOutputDevices(next: OutputDevice[]): void {
	if (areOutputDeviceListsEqual(outputDeviceCache, next)) {
		return;
	}
	outputDeviceCache = next;
	for (const subscriber of outputDeviceSubscribers) {
		subscriber();
	}
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function publishBrowserSinkIds(next: string[]): void {
	if (arraysEqual(browserSinkIdsCache, next)) {
		return;
	}
	browserSinkIdsCache = next;
	for (const subscriber of browserSinkIdsSubscribers) {
		subscriber();
	}
}

function normalizeOutputName(name: string): string {
	return name.trim().toLowerCase();
}

function containsText(haystack: string, needle: string): boolean {
	return haystack.indexOf(needle) >= 0;
}

/**
 * Resolve a backend device name to a browser `deviceId` usable with
 * ``setSinkId``. Exact (normalized) match first, then a contains match for the
 * minor framing differences between cpal names and browser labels. When the
 * browser doesn't know the device yet (e.g. just hot-plugged, or no mic
 * permission so labels are blank), fall back to the device name as a stable,
 * non-empty synthetic id — the device still SHOWS in the picker, and routing to
 * it degrades gracefully to the system default (``routeContextToSink`` /
 * ``createOutputContext`` both swallow an unknown sinkId). A newly-plugged
 * device is usually the system default anyway, so the default ("") option still
 * reaches it.
 */
function resolveSinkId(name: string): string {
	const normalized = normalizeOutputName(name);
	const exact = browserSinkMap.get(normalized);
	if (exact !== undefined) {
		return exact;
	}
	for (const [label, deviceId] of browserSinkMap) {
		if (containsText(label, normalized) || containsText(normalized, label)) {
			return deviceId;
		}
	}
	return name;
}

function mergeBackendOutputDevices(): OutputDevice[] {
	return backendOutputDevices.map((device) => ({
		deviceId: resolveSinkId(device.name),
		label: device.name,
		isDefault: device.isDefault,
	}));
}

function recomputeOutputDevices(): void {
	const merged =
		backendOutputDevices.length > 0
			? mergeBackendOutputDevices()
			: browserOutputDevices;
	publishOutputDevices(merged);
}

function refreshBrowserOutputDevices(): Promise<void> {
	if (outputDeviceRefreshInFlight) {
		return outputDeviceRefreshInFlight;
	}
	if (typeof navigator === "undefined" || !navigator.mediaDevices) {
		return Promise.resolve();
	}
	outputDeviceRefreshInFlight = navigator.mediaDevices
		.enumerateDevices()
		.then((raw) => {
			const outputs: OutputDevice[] = [];
			const sinkMap = new Map<string, string>();
			let fallbackCounter = 1;
			for (const d of raw) {
				if (d.kind !== "audiooutput") {
					continue;
				}
				// Special ``default`` / ``communications`` deviceIds appear on
				// Chromium; the first non-special entry is the system default.
				// `isDefault` is set on the entry whose deviceId equals ``default``
				// (Chromium emits it as a dedicated row before the actual default
				// device) so the consumer can highlight it.
				outputs.push({
					deviceId: d.deviceId,
					label: d.label || `Output ${fallbackCounter++}`,
					isDefault: d.deviceId === "default",
				});
				// Index real, named device rows for the backend→browser name join.
				// Skip the synthetic ``default``/``communications`` rows and unlabeled
				// entries (no mic permission yet) — those can't be matched by name.
				if (
					d.label &&
					d.deviceId !== "default" &&
					d.deviceId !== "communications" &&
					d.deviceId !== ""
				) {
					sinkMap.set(normalizeOutputName(d.label), d.deviceId);
				}
			}
			browserOutputDevices = outputs;
			browserSinkMap = sinkMap;
			publishBrowserSinkIds(Array.from(sinkMap.values()));
			recomputeOutputDevices();
		})
		.finally(() => {
			outputDeviceRefreshInFlight = null;
		});
	return outputDeviceRefreshInFlight;
}

function applyBackendOutputDevices(devices: AudioOutputDevice[]): void {
	backendOutputDevices = devices;
	recomputeOutputDevices();
}

function loadBackendOutputDevices(): Promise<void> {
	return audioGetOutputDevices().then(applyBackendOutputDevices);
}

function refreshBackendOutputDevices(): Promise<void> {
	return audioRefreshOutputDevices().then(applyBackendOutputDevices);
}

function refreshOutputDevices(): Promise<void> {
	return Promise.all([
		refreshBackendOutputDevices(),
		refreshBrowserOutputDevices(),
	]).then(() => undefined);
}

// External-store adapters for `useSyncExternalStore`. The caches are only
// reassigned (to a fresh array) inside `publishOutputDevices` /
// `publishBrowserSinkIds`, which already short-circuit when the contents are
// unchanged — so each snapshot getter returns a referentially stable value
// between real changes, satisfying `useSyncExternalStore`'s tearing guard.
function subscribeOutputDevices(onStoreChange: () => void): () => void {
	outputDeviceSubscribers.add(onStoreChange);
	return () => {
		outputDeviceSubscribers.delete(onStoreChange);
	};
}

function getOutputDevicesSnapshot(): OutputDevice[] {
	return outputDeviceCache;
}

function subscribeBrowserSinkIds(onStoreChange: () => void): () => void {
	browserSinkIdsSubscribers.add(onStoreChange);
	return () => {
		browserSinkIdsSubscribers.delete(onStoreChange);
	};
}

function getBrowserSinkIdsSnapshot(): string[] {
	return browserSinkIdsCache;
}

/**
 * Returns the list of audio OUTPUT devices, kept in sync with hot-plug events
 * in real time — exactly like :func:`useInputDevices`.
 *
 * The device MEMBERSHIP (which speakers exist + which is the system default)
 * comes from the Rust/cpal backend, pushed over ``audio:output-devices-changed``
 * by the native audio-endpoint watcher. The renderer additionally enumerates
 * ``navigator.mediaDevices`` purely to obtain each device's
 * ``MediaDeviceInfo.deviceId`` (the only value ``setSinkId`` accepts), joining
 * it to the backend list by name.
 *
 * Why not enumerate output devices entirely in the browser (as before): the
 * embedded WebView2's ``enumerateDevices()`` cache does not reliably refresh on
 * output hot-plug, so the picker would never see a newly-plugged speaker. The
 * backend's WASAPI/CoreAudio endpoint notifications do, which is why the input
 * list already routes through Rust.
 *
 * Permissions: ``enumerateDevices()`` returns empty ``label`` strings until the
 * user grants microphone permission once (WinSTT does this during onboarding).
 * Until then the backend still provides real device NAMES for display, and
 * routing to a non-default device falls back to the system default.
 */
export function useOutputDevices(): UseOutputDevicesResult {
	const devices = useSyncExternalStore(
		subscribeOutputDevices,
		getOutputDevicesSnapshot,
	);
	const sinkIds = useSyncExternalStore(
		subscribeBrowserSinkIds,
		getBrowserSinkIdsSnapshot,
	);

	const refresh = refreshOutputDevices;

	useEffect(() => {
		// Real-time backend push: a hot-plugged speaker shows up the instant the
		// native endpoint watcher reports it, without waiting on the browser.
		const offOutputDevicesChanged = onAudioOutputDevicesChanged(
			applyBackendOutputDevices,
		);
		return () => {
			offOutputDevicesChanged();
		};
	}, []);

	useEffect(() => {
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		const refreshBrowserSafely = () => {
			fireAndForget(
				refreshBrowserOutputDevices(),
				"outputDevices.refreshBrowser",
			);
		};
		const scheduleBrowserRefresh = () => {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				refreshBrowserSafely();
			}, DEVICECHANGE_DEBOUNCE_MS);
		};
		// Initial load: backend (authoritative membership) + browser (sink ids).
		fireAndForget(loadBackendOutputDevices(), "outputDevices.loadBackend");
		refreshBrowserSafely();
		// The generic backend devicechange ping also re-reads the browser sink map
		// so deviceIds resolve as soon as the browser catches up.
		const offDeviceChangeDetected = onAudioDeviceChangeDetected(
			scheduleBrowserRefresh,
		);
		const mediaDevices =
			typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
		mediaDevices?.addEventListener("devicechange", scheduleBrowserRefresh);
		return () => {
			offDeviceChangeDetected();
			mediaDevices?.removeEventListener("devicechange", scheduleBrowserRefresh);
			const pendingDebounce = debounceTimer;
			debounceTimer = null;
			if (pendingDebounce) {
				clearTimeout(pendingDebounce);
			}
		};
	}, []);

	const defaultDevice = devices.find((d) => d.isDefault) ?? devices[0] ?? null;
	return { devices, defaultDevice, refresh, sinkIds };
}

export function _resetOutputDevicesCacheForTests(): void {
	outputDeviceCache = [];
	outputDeviceRefreshInFlight = null;
	outputDeviceSubscribers.clear();
	backendOutputDevices = [];
	browserSinkMap = new Map();
	browserOutputDevices = [];
	browserSinkIdsCache = [];
	browserSinkIdsSubscribers.clear();
}

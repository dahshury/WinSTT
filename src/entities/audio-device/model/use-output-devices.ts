import { useCallback, useEffect, useRef, useState } from "react";
import { onAudioDeviceChangeDetected } from "@/shared/api/ipc-client";

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
  if (a.length !== b.length) {
    return false;
  }
  return a.every((device, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      device.deviceId === other.deviceId &&
      device.label === other.label &&
      device.isDefault === other.isDefault
    );
  });
}

let outputDeviceCache: OutputDevice[] = [];
let outputDeviceRefreshInFlight: Promise<void> | null = null;
const outputDeviceSubscribers = new Set<(devices: OutputDevice[]) => void>();

function publishOutputDevices(next: OutputDevice[]): void {
  if (areOutputDeviceListsEqual(outputDeviceCache, next)) {
    return;
  }
  outputDeviceCache = next;
  for (const subscriber of outputDeviceSubscribers) {
    subscriber(next);
  }
}

function refreshOutputDeviceCache(): Promise<void> {
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
      }
      publishOutputDevices(outputs);
    })
    .finally(() => {
      outputDeviceRefreshInFlight = null;
    });
  return outputDeviceRefreshInFlight;
}

/**
 * Returns the list of audio OUTPUT devices reported by the browser via
 * ``navigator.mediaDevices.enumerateDevices()`` (filtered to
 * ``kind === "audiooutput"``).
 *
 * Why the renderer-side enumeration (vs. backend-side input enumeration): output
 * device routing is handled in the renderer — recording-sound chimes
 * play via ``HTMLAudioElement``, TTS plays via ``AudioContext``, both
 * accept ``setSinkId(deviceId)``. The backend never sees the deviceId, so
 * adding an IPC enumeration just for outputs would be redundant.
 *
 * Permissions: enumerateDevices() returns empty ``label`` strings until
 * the user has granted microphone permission once. WinSTT already prompts
 * for that during onboarding (OnboardingMicTestStep), so on the live app
 * the labels are populated by the time the user reaches this picker.
 * When labels are empty (no permission yet), we fall back to ``Output 1``
 * / ``Output 2`` / ... so the picker is still usable.
 */
export function useOutputDevices(): UseOutputDevicesResult {
  const [devices, setDevices] = useState<OutputDevice[]>(
    () => outputDeviceCache,
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => refreshOutputDeviceCache(), []);

  useEffect(() => {
    outputDeviceSubscribers.add(setDevices);
    setDevices(outputDeviceCache);
    return () => {
      outputDeviceSubscribers.delete(setDevices);
    };
  }, []);

  useEffect(() => {
    const refreshSafely = () => {
      refresh().catch(() => undefined);
    };
    const scheduleRefresh = () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        refreshSafely();
      }, DEVICECHANGE_DEBOUNCE_MS);
    };
    refreshSafely();
    const offDeviceChangeDetected =
      onAudioDeviceChangeDetected(scheduleRefresh);
    const mediaDevices =
      typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    mediaDevices?.addEventListener("devicechange", scheduleRefresh);
    return () => {
      offDeviceChangeDetected();
      mediaDevices?.removeEventListener("devicechange", scheduleRefresh);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [refresh]);

  const defaultDevice = devices.find((d) => d.isDefault) ?? devices[0] ?? null;
  return { devices, defaultDevice, refresh };
}

export function _resetOutputDevicesCacheForTests(): void {
  outputDeviceCache = [];
  outputDeviceRefreshInFlight = null;
  outputDeviceSubscribers.clear();
}

import { useEffect, useMemo, useState } from "react";
import {
  type MicrophoneLevelMonitorTarget,
  onMicrophoneLevels,
  startMicrophoneLevelMonitor,
  stopMicrophoneLevelMonitor,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";

const METER_SEGMENTS = 6;
const METER_FULL_SCALE = 0.12;

function monitorTargetForOption(id: string): MicrophoneLevelMonitorTarget {
  if (id === "default") {
    return { id, deviceIndex: null };
  }
  const deviceIndex = Number.parseInt(id, 10);
  return {
    id,
    deviceIndex: Number.isFinite(deviceIndex) ? deviceIndex : null,
  };
}

function monitorTargetKey(
  targets: readonly MicrophoneLevelMonitorTarget[],
): string {
  return targets
    .map((target) => `${target.id}:${target.deviceIndex ?? "default"}`)
    .join("|");
}

export function useMicrophoneLevels(
  enabled: boolean,
  optionIds: readonly string[],
): Record<string, number> {
  const optionIdsKey = optionIds.join("|");
  const targets = useMemo(
    () =>
      optionIdsKey
        .split("|")
        .filter((id) => id.length > 0)
        .map(monitorTargetForOption),
    [optionIdsKey],
  );
  const targetsKey = monitorTargetKey(targets);
  const [levels, setLevels] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!enabled) {
      setLevels({});
      return;
    }
    return onMicrophoneLevels((payload) => {
      setLevels(
        Object.fromEntries(
          payload.levels.map((entry) => [
            entry.id,
            Math.max(0, Math.min(1, entry.level)),
          ]),
        ),
      );
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    setLevels({});
    void startMicrophoneLevelMonitor(targets);
    return () => {
      void stopMicrophoneLevelMonitor();
    };
  }, [enabled, targets, targetsKey]);

  return levels;
}

export function MicrophoneLevelMeter({
  active,
  level,
}: {
  active: boolean;
  level: number;
}) {
  const substrate = useSurface();
  const trackLevel = Math.min(substrate + (active ? 2 : 1), 8);
  const normalized = Math.min(
    1,
    Math.sqrt(Math.max(0, level) / METER_FULL_SCALE),
  );
  const filled = normalized * METER_SEGMENTS;
  return (
    <span
      aria-hidden="true"
      data-slot="microphone-level-meter"
      className={cn(
        "flex h-[22px] w-[18px] shrink-0 flex-col-reverse justify-center gap-[2px]",
        active ? "opacity-100" : "opacity-90",
      )}
    >
      {Array.from({ length: METER_SEGMENTS }, (_, i) => {
        const amount = Math.max(0, Math.min(1, filled - i));
        return (
          <span
            className={cn(
              "block h-[2px] w-full overflow-hidden rounded-full ring-1 ring-divider-strong ring-inset",
              surfaceBg(trackLevel),
            )}
            data-slot="microphone-level-meter-segment"
            key={`meter-${i}`}
          >
            <span
              className="block h-full rounded-full bg-accent shadow-[0_0_6px_var(--color-accent-glow-strong)] transition-transform duration-75 ease-linear"
              data-slot="microphone-level-meter-fill"
              style={{
                opacity: amount > 0 ? 1 : 0,
                transform: `scaleX(${amount})`,
                transformOrigin: "right center",
              }}
            />
          </span>
        );
      })}
    </span>
  );
}

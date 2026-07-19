import { useEffect, useState } from "react";
import {
	type MicrophoneLevelMonitorTarget,
	onMicrophoneLevels,
	startMicrophoneLevelMonitor,
	stopMicrophoneLevelMonitor,
} from "@/shared/api/ipc-client";

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

export function useMicrophoneLevels(
	enabled: boolean,
	optionIds: readonly string[],
): Record<string, number> {
	const optionIdsKey = optionIds.join("|");
	const currentKey = enabled ? optionIdsKey : null;
	const [state, setState] = useState<{
		key: string | null;
		levels: Record<string, number>;
	}>({ key: null, levels: {} });

	useEffect(() => {
		if (!enabled) {
			return;
		}
		// The targets are rebuilt INSIDE the effect from the identity-stable
		// string key. Depending on a freshly-mapped targets array restarted the
		// monitor (stop + start, reopening every input device) on each levels
		// payload — every payload re-rendered the consumer, remapping the array
		// — flapping the microphones open/closed for as long as any meter was
		// on screen.
		const targets = optionIdsKey
			.split("|")
			.filter((id) => id.length > 0)
			.map(monitorTargetForOption);
		const key = optionIdsKey;
		const unsubscribe = onMicrophoneLevels((payload) => {
			setState({
				key,
				levels: Object.fromEntries(
					payload.levels.map((entry) => [
						entry.id,
						Math.max(0, Math.min(1, entry.level)),
					]),
				),
			});
		});
		void startMicrophoneLevelMonitor(targets);
		return () => {
			unsubscribe();
			void stopMicrophoneLevelMonitor();
		};
	}, [enabled, optionIdsKey]);

	return state.key === currentKey ? state.levels : {};
}

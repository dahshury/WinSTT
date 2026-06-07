import { useCallback, useEffect, useState } from "react";
import type {
	ContextDebugReport,
	ContextPlaygroundPush,
	ContextPlaygroundWaitReason,
} from "@/shared/api/context-debug-types";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcOn, ipcSend } from "@/shared/api/ipc-client";
import { useEscapeToClose } from "@/shared/lib/window-effects";

/**
 * State controller for the context-awareness playground (debug view).
 *
 * Subscribes to the `CONTEXT_PLAYGROUND_REPORT` push channel and mirrors the
 * reference main poll loop:
 *   - `report` is the last EXTERNAL-field capture (kept, never clobbered by a
 *     "waiting" heartbeat).
 *   - `waiting` is the reason the loop currently can't capture (the playground
 *     itself holds focus, or live mode is off).
 *
 * On mount it sends `SET_LIVE { enabled: true }`, which both flips live polling
 * on in main AND signals "renderer ready" so a capture lands promptly.
 */
export interface ContextPlaygroundController {
	armDeep: () => void;
	deepArmed: boolean;
	live: boolean;
	report: ContextDebugReport | null;
	toggleLive: () => void;
	waiting: ContextPlaygroundWaitReason | null;
}

export function useContextPlayground(): ContextPlaygroundController {
	const [report, setReport] = useState<ContextDebugReport | null>(null);
	const [waiting, setWaiting] = useState<ContextPlaygroundWaitReason | null>(
		null,
	);
	const [live, setLive] = useState(true);
	const [deepArmed, setDeepArmed] = useState(false);
	const close = useCallback(() => ipcSend(IPC.CONTEXT_PLAYGROUND_CLOSE), []);
	useEscapeToClose(close);

	useEffect(() => {
		const unsubscribe = ipcOn(IPC.CONTEXT_PLAYGROUND_REPORT, (payload) => {
			const push = payload as ContextPlaygroundPush;
			if (push.kind === "report") {
				setReport(push.report);
				setWaiting(null);
				// A capture landed — if a deep capture was armed, it has now fired.
				setDeepArmed(false);
			} else {
				setWaiting(push.reason);
			}
		});
		ipcSend(IPC.CONTEXT_PLAYGROUND_SET_LIVE, { enabled: true });
		return () => {
			unsubscribe();
		};
	}, []);

	const toggleLive = () => {
		const next = !live;
		setLive(next);
		ipcSend(IPC.CONTEXT_PLAYGROUND_SET_LIVE, { enabled: next });
	};

	const armDeep = () => {
		setDeepArmed(true);
		ipcSend(IPC.CONTEXT_PLAYGROUND_ARM_DEEP);
	};

	return { armDeep, deepArmed, live, report, toggleLive, waiting };
}

/** Re-renders once per second so the "captured Ns ago" label stays live. */
export function useNow(intervalMs = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
}

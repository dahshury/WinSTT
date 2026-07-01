import { useEffect, useState } from "react";
import type {
	ContextDebugReport,
	ContextPlaygroundPush,
	ContextPlaygroundWaitReason,
} from "@/shared/api/context-debug-types";
import { useEscapeToClose } from "@/shared/lib/window-effects";

export interface ContextPlaygroundController {
	armDeep: () => void;
	deepArmed: boolean;
	live: boolean;
	report: ContextDebugReport | null;
	toggleLive: () => void;
	waiting: ContextPlaygroundWaitReason | null;
}

async function setContextPlaygroundLive(live: boolean): Promise<void> {
	const { contextPlaygroundSetLive } = await import("@/shared/api/ipc-client");
	contextPlaygroundSetLive(live);
}

function closeContextPlayground(): void {
	void import("@/shared/api/ipc-client").then(
		({ contextPlaygroundSetLive, windowCloseNamed }) => {
			contextPlaygroundSetLive(false);
			windowCloseNamed("context-playground");
		},
	);
}

export function useContextPlayground(): ContextPlaygroundController {
	const [report, setReport] = useState<ContextDebugReport | null>(null);
	const [waiting, setWaiting] = useState<ContextPlaygroundWaitReason | null>(
		null,
	);
	const [live, setLive] = useState(true);
	const [deepArmed, setDeepArmed] = useState(false);
	useEscapeToClose(closeContextPlayground);

	useEffect(() => {
		let cancelled = false;
		let unsubscribe = () => {};
		void Promise.all([
			// eslint-disable-next-line react-hooks-js/todo -- dynamic import is intentional code-splitting; compiler cannot lower it but behavior is correct
			import("@/shared/api/ipc-channels"),
			// eslint-disable-next-line react-hooks-js/todo -- dynamic import is intentional code-splitting; compiler cannot lower it but behavior is correct
			import("@/shared/api/ipc-client"),
		]).then(([{ IPC }, { contextPlaygroundSetLive, ipcOn }]) => {
			if (cancelled) {
				contextPlaygroundSetLive(false);
				return;
			}
			unsubscribe = ipcOn(IPC.CONTEXT_PLAYGROUND_REPORT, (payload) => {
				const push = payload as ContextPlaygroundPush;
				if (push.kind === "report") {
					setReport(push.report);
					setWaiting(null);
					setDeepArmed(false);
				} else {
					setWaiting(push.reason);
				}
			});
			contextPlaygroundSetLive(true);
		});
		return () => {
			cancelled = true;
			void setContextPlaygroundLive(false);
			unsubscribe();
		};
	}, []);

	const toggleLive = () => {
		const next = !live;
		setLive(next);
		void setContextPlaygroundLive(next);
	};

	const armDeep = () => {
		setDeepArmed(true);
		// eslint-disable-next-line react-hooks-js/todo -- dynamic import is intentional code-splitting; compiler cannot lower it but behavior is correct
		void import("@/shared/api/ipc-client").then(
			({ contextPlaygroundArmDeep }) => contextPlaygroundArmDeep(),
		);
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

import { type Dispatch, useEffect, useReducer, useRef } from "react";
import {
	hotkeyStartRecording,
	hotkeyStopRecording,
	onHotkeyRecordingDone,
	onHotkeyRecordingUpdate,
} from "@/shared/api/ipc-client";

interface UseKeyRecorderOptions {
	onKeyRecorded?: (key: string) => void;
}

interface UseKeyRecorderReturn {
	key: string | null;
	liveKeys: string[];
	recording: boolean;
	startRecording: () => void;
	stopRecording: () => void;
}

interface RecorderState {
	key: string | null;
	liveKeys: string[];
	recording: boolean;
}

type RecorderAction =
	| { type: "start" }
	| { type: "stop" }
	| { type: "live"; keys: string[] }
	| { type: "done"; combo: string | null };

const INITIAL_STATE: RecorderState = {
	key: null,
	liveKeys: [],
	recording: false,
};

const MODIFIER_ORDER = new Map<string, number>([
	["LCtrl", 0],
	["RCtrl", 1],
	["LAlt", 2],
	["RAlt", 3],
	["LShift", 4],
	["RShift", 5],
	["LMeta", 6],
	["RMeta", 7],
]);

type ActionHandler<A extends RecorderAction> = (
	state: RecorderState,
	action: A,
) => RecorderState;

const ACTION_HANDLERS: {
	[K in RecorderAction["type"]]: ActionHandler<
		Extract<RecorderAction, { type: K }>
	>;
} = {
	start: () => ({ key: null, liveKeys: [], recording: true }),
	stop: (state) => ({ ...state, recording: false }),
	live: (state, action) => ({ ...state, liveKeys: action.keys }),
	done: (state, action) => ({
		key: action.combo ?? state.key,
		liveKeys: [],
		recording: false,
	}),
};

function recorderReducer(
	state: RecorderState,
	action: RecorderAction,
): RecorderState {
	const handler = ACTION_HANDLERS[action.type] as ActionHandler<RecorderAction>;
	return handler(state, action);
}

function keyNameFromEvent(event: KeyboardEvent): string | null {
	switch (event.code) {
		case "ControlLeft":
			return "LCtrl";
		case "ControlRight":
			return "RCtrl";
		case "AltLeft":
			return "LAlt";
		case "AltRight":
			return "RAlt";
		case "ShiftLeft":
			return "LShift";
		case "ShiftRight":
			return "RShift";
		case "MetaLeft":
			return "LMeta";
		case "MetaRight":
			return "RMeta";
		case "Space":
			return "Space";
		case "Tab":
			return "Tab";
		case "Enter":
		case "NumpadEnter":
			return "Enter";
		case "Escape":
			return "Escape";
		case "Backspace":
			return "Backspace";
		case "Delete":
			return "Delete";
		case "Insert":
			return "Insert";
		case "Home":
			return "Home";
		case "End":
			return "End";
		case "PageUp":
			return "PageUp";
		case "PageDown":
			return "PageDown";
		case "ArrowLeft":
		case "ArrowRight":
		case "ArrowUp":
		case "ArrowDown":
			return event.code;
		default:
			break;
	}

	if (/^Key[A-Z]$/.test(event.code)) {
		return event.code.slice(3);
	}
	if (/^Digit[0-9]$/.test(event.code)) {
		return event.code.slice(5);
	}
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) {
		return event.code;
	}
	if (/^Numpad[0-9]$/.test(event.code)) {
		return event.code.replace("Numpad", "Num");
	}
	return null;
}

function sortKeys(keys: readonly string[]): string[] {
	return Array.from(new Set(keys)).sort((a, b) => {
		const aRank = MODIFIER_ORDER.get(a);
		const bRank = MODIFIER_ORDER.get(b);
		if (aRank !== undefined || bRank !== undefined) {
			return (aRank ?? 100) - (bRank ?? 100);
		}
		return a.localeCompare(b);
	});
}

function comboFromPeak(keys: readonly string[]): string | null {
	if (
		keys.length === 0 ||
		(keys.length === 1 && MODIFIER_ORDER.has(keys[0] ?? ""))
	) {
		return null;
	}
	return keys.join("+");
}

function finishRecorderState(
	combo: string | null,
	sendStop: boolean,
	pendingDoneRef: { current: boolean },
	recordingRef: { current: boolean },
	heldKeysRef: { current: string[] },
	peakKeysRef: { current: string[] },
	onKeyRecordedRef: { current: ((key: string) => void) | undefined },
	dispatch: Dispatch<RecorderAction>,
): void {
	pendingDoneRef.current = false;
	recordingRef.current = false;
	heldKeysRef.current = [];
	peakKeysRef.current = [];
	dispatch({ type: "done", combo });
	if (combo) {
		onKeyRecordedRef.current?.(combo);
	}
	if (sendStop) {
		hotkeyStopRecording();
	}
}

export function useKeyRecorder({
	onKeyRecorded,
}: UseKeyRecorderOptions = {}): UseKeyRecorderReturn {
	const [state, dispatch] = useReducer(recorderReducer, INITIAL_STATE);
	const recordingRef = useRef(false);
	const heldKeysRef = useRef<string[]>([]);
	const peakKeysRef = useRef<string[]>([]);
	// Separate from `recordingRef` so the Stop button can flip the UI out of
	// "recording" immediately without losing the done-event reply that the main
	// process emits after `hotkey:stop-recording`. Multiple HotkeyRecorder
	// instances share the global IPC channel, so this also identifies which
	// instance owns the next done event.
	const pendingDoneRef = useRef(false);
	const onKeyRecordedRef = useRef(onKeyRecorded);
	useEffect(() => {
		onKeyRecordedRef.current = onKeyRecorded;
	}, [onKeyRecorded]);

	const startRecording = () => {
		recordingRef.current = true;
		pendingDoneRef.current = true;
		heldKeysRef.current = [];
		peakKeysRef.current = [];
		dispatch({ type: "start" });
		hotkeyStartRecording();
	};

	const stopRecording = () => {
		if (recordingRef.current) {
			const combo = comboFromPeak(peakKeysRef.current);
			dispatch({ type: "stop" });
			finishRecorderState(
				combo,
				true,
				pendingDoneRef,
				recordingRef,
				heldKeysRef,
				peakKeysRef,
				onKeyRecordedRef,
				dispatch,
			);
		}
	};

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (!recordingRef.current) {
				return;
			}
			const key = keyNameFromEvent(event);
			if (!key) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();

			if (key === "Escape") {
				finishRecorderState(
					null,
					true,
					pendingDoneRef,
					recordingRef,
					heldKeysRef,
					peakKeysRef,
					onKeyRecordedRef,
					dispatch,
				);
				return;
			}

			heldKeysRef.current = sortKeys([...heldKeysRef.current, key]);
			if (heldKeysRef.current.length > peakKeysRef.current.length) {
				peakKeysRef.current = heldKeysRef.current;
			}
			dispatch({ type: "live", keys: heldKeysRef.current });
		};

		const handleKeyUp = (event: KeyboardEvent) => {
			if (!recordingRef.current) {
				return;
			}
			const key = keyNameFromEvent(event);
			if (!key) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();

			heldKeysRef.current = heldKeysRef.current.filter((held) => held !== key);
			dispatch({ type: "live", keys: heldKeysRef.current });
		};

		window.addEventListener("keydown", handleKeyDown, { capture: true });
		window.addEventListener("keyup", handleKeyUp, { capture: true });
		return () => {
			window.removeEventListener("keydown", handleKeyDown, { capture: true });
			window.removeEventListener("keyup", handleKeyUp, { capture: true });
		};
	}, []);

	useEffect(() => {
		const unsubUpdate = onHotkeyRecordingUpdate((keys) => {
			if (recordingRef.current) {
				const sorted = sortKeys(keys);
				heldKeysRef.current = sorted;
				if (sorted.length > peakKeysRef.current.length) {
					peakKeysRef.current = sorted;
				}
				dispatch({ type: "live", keys });
			}
		});

		const unsubDone = onHotkeyRecordingDone((combo) => {
			// Multiple HotkeyRecorder instances share this global IPC channel.
			// Only the instance that initiated the recording owns the done
			// event; otherwise every mounted recorder would overwrite its
			// setting with the same combo on a single keypress.
			if (!pendingDoneRef.current) {
				return;
			}
			finishRecorderState(
				combo,
				false,
				pendingDoneRef,
				recordingRef,
				heldKeysRef,
				peakKeysRef,
				onKeyRecordedRef,
				dispatch,
			);
		});

		return () => {
			unsubUpdate();
			unsubDone();
		};
	}, []);

	return {
		recording: state.recording,
		key: state.key,
		liveKeys: state.liveKeys,
		startRecording,
		stopRecording,
	};
}

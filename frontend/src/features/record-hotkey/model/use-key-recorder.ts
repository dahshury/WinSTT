"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
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

const INITIAL_STATE: RecorderState = { key: null, liveKeys: [], recording: false };

type ActionHandler<A extends RecorderAction> = (state: RecorderState, action: A) => RecorderState;

const ACTION_HANDLERS: {
	[K in RecorderAction["type"]]: ActionHandler<Extract<RecorderAction, { type: K }>>;
} = {
	start: () => ({ key: null, liveKeys: [], recording: true }),
	stop: (state) => ({ ...state, recording: false }),
	live: (state, action) => ({ ...state, liveKeys: action.keys }),
	done: (state, action) => ({ key: action.combo ?? state.key, liveKeys: [], recording: false }),
};

function recorderReducer(state: RecorderState, action: RecorderAction): RecorderState {
	const handler = ACTION_HANDLERS[action.type] as ActionHandler<RecorderAction>;
	return handler(state, action);
}

export function useKeyRecorder({
	onKeyRecorded,
}: UseKeyRecorderOptions = {}): UseKeyRecorderReturn {
	const [state, dispatch] = useReducer(recorderReducer, INITIAL_STATE);
	const recordingRef = useRef(false);
	const onKeyRecordedRef = useRef(onKeyRecorded);
	onKeyRecordedRef.current = onKeyRecorded;

	const startRecording = useCallback(() => {
		recordingRef.current = true;
		dispatch({ type: "start" });
		hotkeyStartRecording();
	}, []);

	const stopRecording = useCallback(() => {
		if (recordingRef.current) {
			recordingRef.current = false;
			dispatch({ type: "stop" });
			hotkeyStopRecording();
		}
	}, []);

	useEffect(() => {
		const unsubUpdate = onHotkeyRecordingUpdate((keys) => {
			if (recordingRef.current) {
				dispatch({ type: "live", keys });
			}
		});

		const unsubDone = onHotkeyRecordingDone((combo) => {
			recordingRef.current = false;
			dispatch({ type: "done", combo });
			if (combo) {
				onKeyRecordedRef.current?.(combo);
			}
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

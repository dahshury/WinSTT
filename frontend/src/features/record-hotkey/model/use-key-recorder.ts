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

function recorderReducer(state: RecorderState, action: RecorderAction): RecorderState {
	switch (action.type) {
		case "start":
			return { key: null, liveKeys: [], recording: true };
		case "stop":
			return { ...state, recording: false };
		case "live":
			return { ...state, liveKeys: action.keys };
		case "done":
			return {
				key: action.combo ?? state.key,
				liveKeys: [],
				recording: false,
			};
		default:
			return state;
	}
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

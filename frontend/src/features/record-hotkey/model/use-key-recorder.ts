"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	hotkeyStartRecording,
	hotkeyStopRecording,
	onHotkeyRecordingDone,
	onHotkeyRecordingUpdate,
} from "@/shared/api/ipc-client";

interface UseKeyRecorderReturn {
	recording: boolean;
	key: string | null;
	liveKeys: string[];
	startRecording: () => void;
	stopRecording: () => void;
}

export function useKeyRecorder(): UseKeyRecorderReturn {
	const [recording, setRecording] = useState(false);
	const [key, setKey] = useState<string | null>(null);
	const [liveKeys, setLiveKeys] = useState<string[]>([]);
	const recordingRef = useRef(false);

	const startRecording = useCallback(() => {
		setRecording(true);
		setKey(null);
		setLiveKeys([]);
		recordingRef.current = true;
		hotkeyStartRecording();
	}, []);

	const stopRecording = useCallback(() => {
		if (recordingRef.current) {
			recordingRef.current = false;
			setRecording(false);
			hotkeyStopRecording();
			// liveKeys kept until done event clears them
		}
	}, []);

	useEffect(() => {
		const unsubUpdate = onHotkeyRecordingUpdate((keys) => {
			if (recordingRef.current) {
				setLiveKeys(keys);
			}
		});

		const unsubDone = onHotkeyRecordingDone((combo) => {
			recordingRef.current = false;
			setRecording(false);
			setLiveKeys([]);
			if (combo) {
				setKey(combo);
			}
		});

		return () => {
			unsubUpdate();
			unsubDone();
		};
	}, []);

	return { recording, key, liveKeys, startRecording, stopRecording };
}

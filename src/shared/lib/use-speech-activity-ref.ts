import { useEffect, useRef } from "react";
import {
	onRecordingStart,
	onRecordingStop,
	onSttSessionAborted,
	onVadStart,
	onVadStop,
} from "@/shared/api/ipc-client";

/**
 * Mutable ref for animation gates that need to know whether a live dictation
 * session is active without rerendering on every recording/VAD event.
 */
export function useSpeechActivityRef() {
	const activeRef = useRef(false);
	const recordingRef = useRef(false);
	const speakingRef = useRef(false);

	useEffect(() => {
		const sync = () => {
			activeRef.current = recordingRef.current || speakingRef.current;
		};
		const stop = () => {
			recordingRef.current = false;
			speakingRef.current = false;
			sync();
		};

		const unsubRecordingStart = onRecordingStart(() => {
			recordingRef.current = true;
			sync();
		});
		const unsubRecordingStop = onRecordingStop(stop);
		const unsubSessionAborted = onSttSessionAborted(stop);
		const unsubVadStart = onVadStart(() => {
			speakingRef.current = true;
			sync();
		});
		const unsubVadStop = onVadStop(() => {
			speakingRef.current = false;
			sync();
		});

		return () => {
			unsubRecordingStart();
			unsubRecordingStop();
			unsubSessionAborted();
			unsubVadStart();
			unsubVadStop();
		};
	}, []);

	return activeRef;
}

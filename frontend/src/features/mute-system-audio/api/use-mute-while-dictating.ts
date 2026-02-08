"use client";

import { useEffect } from "react";
import { audioSetMute, onRecordingStart, onRecordingStop } from "@/shared/api/ipc-client";

export function useMuteWhileDictating(enabled: boolean) {
	useEffect(() => {
		if (!enabled) {
			return;
		}

		const unsubStart = onRecordingStart(() => {
			audioSetMute(true);
		});

		const unsubStop = onRecordingStop(() => {
			audioSetMute(false);
		});

		return () => {
			unsubStart();
			unsubStop();
			audioSetMute(false);
		};
	}, [enabled]);
}

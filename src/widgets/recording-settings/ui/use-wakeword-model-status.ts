import { useEffect, useEffectEvent, useState } from "react";
import {
	onWakewordModelStatus,
	wakewordModelStatus,
	type WakewordModelStatusPayload,
} from "@/shared/api/ipc-client";
import { WAKEWORD_MODEL_STATUS_DEFAULT } from "./recording-settings-types";

export function useWakewordModelStatus(
	onStatus?: (next: WakewordModelStatusPayload) => void,
): WakewordModelStatusPayload {
	const [status, setStatus] = useState<WakewordModelStatusPayload>(
		WAKEWORD_MODEL_STATUS_DEFAULT,
	);
	const handleStatus = useEffectEvent((next: WakewordModelStatusPayload) => {
		setStatus(next);
		onStatus?.(next);
	});

	useEffect(() => {
		let mounted = true;
		wakewordModelStatus().then((next) => {
			if (mounted) {
				handleStatus(next);
			}
		});
		const unsubscribe = onWakewordModelStatus((next) => handleStatus(next));
		return () => {
			mounted = false;
			unsubscribe();
		};
	}, []);

	return status;
}

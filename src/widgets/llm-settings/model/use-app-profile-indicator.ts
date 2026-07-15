import { useEffect } from "react";
import {
	listenForAppProfileActive,
	type AppProfileActivePayload,
} from "@/shared/api/native-runtime";
import {
	createTransientNotificationStore,
	type TransientNotificationMeta,
} from "@/shared/lib/create-transient-notification-store";

export interface AppProfileIndicator extends TransientNotificationMeta {
	configurationName: string;
	appExe: string;
}

export const useAppProfileIndicatorStore =
	createTransientNotificationStore<AppProfileIndicator>();

export function useAppProfileIndicator(): void {
	useEffect(
		() =>
			listenForAppProfileActive((payload: AppProfileActivePayload) => {
				useAppProfileIndicatorStore.getState().show({
					configurationName: payload.configurationName,
					appExe: payload.appExe,
				});
			}),
		[],
	);

	const current = useAppProfileIndicatorStore((state) => state.current);
	useEffect(() => {
		if (!current) {
			return;
		}
		const timer = window.setTimeout(
			() => useAppProfileIndicatorStore.getState().clear(),
			4000,
		);
		return () => window.clearTimeout(timer);
	}, [current]);
}

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
	/** WHICH rule won, not merely which app was in front. Two rules on the same
	 *  exe differing only by title/url both match the foreground app, and a
	 *  title-or-url-only rule has no exe at all — so the exe cannot identify the
	 *  rule that fired. The native event carries the id; keep it. */
	ruleId: string;
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
					ruleId: payload.ruleId,
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

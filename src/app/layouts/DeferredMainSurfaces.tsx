import {
	CloudKeyRevertNotice,
	useCloudOfflineAutoRevert,
} from "@/features/revert-cloud-on-key-removal";
import { CloudSttErrorToasts } from "@/features/show-cloud-stt-errors";
import {
	SettingsHydrationErrorNotice,
	SettingsWarningToasts,
} from "@/features/surface-settings-warnings";
import { SwapFailureToast } from "@/features/swap-notifications";
import { TransformToast } from "@/features/transform-notifications";

/** Main-window recovery notices that are not needed for the first visual frame. */
export function DeferredMainSurfaces() {
	useCloudOfflineAutoRevert();

	return (
		<>
			<TransformToast />
			<SwapFailureToast />
			<CloudSttErrorToasts />
			<CloudKeyRevertNotice />
			<SettingsWarningToasts />
			<SettingsHydrationErrorNotice />
		</>
	);
}

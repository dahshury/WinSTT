import { useTransparentBody } from "@/shared/lib/window-effects";
import { DevicePickerWindow } from "@/widgets/device-picker-window";

export function DevicePickerPage() {
	useTransparentBody();
	return <DevicePickerWindow />;
}

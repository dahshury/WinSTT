import { useEffect } from "react";
import { DevicePickerWindow } from "@/widgets/device-picker-window";

export function DevicePickerPage() {
	useEffect(() => {
		document.documentElement.classList.add("bg-transparent");
		document.body.classList.add("bg-transparent");
		return () => {
			document.documentElement.classList.remove("bg-transparent");
			document.body.classList.remove("bg-transparent");
		};
	}, []);

	return <DevicePickerWindow />;
}

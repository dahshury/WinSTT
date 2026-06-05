import { useTransparentBody } from "@/shared/lib/window-effects";
import { ModelPickerWindow } from "@/widgets/model-picker-window";

export function ModelPickerPage() {
	useTransparentBody();
	return <ModelPickerWindow />;
}

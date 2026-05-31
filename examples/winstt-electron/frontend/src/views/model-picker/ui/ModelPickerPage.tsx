import { useEffect } from "react";
import { ModelPickerWindow } from "@/widgets/model-picker-window";

export function ModelPickerPage() {
	useEffect(() => {
		document.documentElement.classList.add("bg-transparent");
		document.body.classList.add("bg-transparent");
		return () => {
			document.documentElement.classList.remove("bg-transparent");
			document.body.classList.remove("bg-transparent");
		};
	}, []);

	return <ModelPickerWindow />;
}

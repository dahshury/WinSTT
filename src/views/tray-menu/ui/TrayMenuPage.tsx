import { useEffect } from "react";
import { TrayMenu } from "@/widgets/tray-menu";

export function TrayMenuPage() {
	useEffect(() => {
		document.documentElement.classList.add("bg-transparent");
		document.body.classList.add("bg-transparent");
		return () => {
			document.documentElement.classList.remove("bg-transparent");
			document.body.classList.remove("bg-transparent");
		};
	}, []);

	return <TrayMenu />;
}

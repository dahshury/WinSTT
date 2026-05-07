"use client";

import { useEffect } from "react";
import { TrayMenu } from "@/widgets/tray-menu";

export function TrayMenuPage() {
	useEffect(() => {
		document.documentElement.style.background = "transparent";
		document.body.style.background = "transparent";
	}, []);

	return <TrayMenu />;
}

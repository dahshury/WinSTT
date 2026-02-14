"use client";

import { TrayMenu } from "@/widgets/tray-menu";

export function TrayMenuPage() {
	return (
		<div className="flex h-screen w-screen items-start justify-start bg-transparent p-[3px]">
			<TrayMenu />
		</div>
	);
}

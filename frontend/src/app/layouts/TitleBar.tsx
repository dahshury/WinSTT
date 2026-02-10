"use client";

import { Separator } from "@base-ui/react/separator";
import { Cancel01Icon, Configuration01Icon, MinusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { windowClose, windowMinimize, windowOpenSettings } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";

export function TitleBar() {
	const t = useTranslations("titleBar");

	return (
		<header className="titlebar-drag flex h-8 shrink-0 items-stretch border-border border-b bg-surface-primary">
			{/* Left: Branding */}
			<div className="flex items-center pl-3">
				<div className="mr-2 size-1.5 rounded-full bg-accent shadow-[0_0_6px_rgba(245,158,11,0.4)]" />
				<span className="font-mono font-semibold text-[11px] text-foreground-secondary uppercase tracking-widest">
					{t("appName")}
				</span>
			</div>

			{/* Spacer - draggable area */}
			<div className="flex-1" />

			{/* Right: Settings gear + window controls */}
			<div className="titlebar-no-drag flex items-center">
				<Button
					className="flex h-full w-8 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 hover:bg-surface-hover hover:text-foreground-secondary"
					onClick={windowOpenSettings}
				>
					<HugeiconsIcon icon={Configuration01Icon} size={13} />
				</Button>
				<Separator className="h-3 w-px self-center bg-border" orientation="vertical" />
				<Button
					className="flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 hover:bg-surface-hover hover:text-foreground-secondary"
					onClick={windowMinimize}
				>
					<HugeiconsIcon icon={MinusSignIcon} size={12} />
				</Button>
				<Button
					className="flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 hover:bg-[#dc2626] hover:text-white"
					onClick={windowClose}
				>
					<HugeiconsIcon icon={Cancel01Icon} size={12} />
				</Button>
			</div>
		</header>
	);
}

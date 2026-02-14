"use client";

import { Separator } from "@base-ui/react/separator";
import { Cancel01Icon, MinusSignIcon, Settings05Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { windowClose, windowMinimize, windowOpenSettings } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";

export function TitleBar() {
	const t = useTranslations("titleBar");

	return (
		<header className="titlebar-drag flex h-8 shrink-0 items-stretch border-border border-b bg-surface-primary">
			{/* Left: Branding */}
			<div className="flex items-center pl-3">
				<Image
					alt=""
					className="mr-1.5 size-4"
					draggable={false}
					height={16}
					src="/icon.ico"
					width={16}
				/>
				<span className="font-mono font-semibold text-[11px] text-foreground-secondary uppercase tracking-widest">
					{t("appName")}
				</span>
			</div>

			{/* Spacer - draggable area */}
			<div className="flex-1" />

			{/* Right: Settings gear + window controls */}
			<div className="titlebar-no-drag flex items-center">
				<Button
					aria-label={t("settings")}
					className="flex h-full w-8 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 hover:bg-surface-hover hover:text-foreground-secondary"
					onClick={windowOpenSettings}
				>
					<HugeiconsIcon icon={Settings05Icon} size={13} />
				</Button>
				<Separator className="h-3 w-px self-center bg-border" orientation="vertical" />
				<Button
					aria-label={t("minimize")}
					className="flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 hover:bg-surface-hover hover:text-foreground-secondary"
					onClick={windowMinimize}
				>
					<HugeiconsIcon icon={MinusSignIcon} size={12} />
				</Button>
				<Button
					aria-label={t("close")}
					className="flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 hover:bg-error hover:text-white"
					onClick={windowClose}
				>
					<HugeiconsIcon icon={Cancel01Icon} size={12} />
				</Button>
			</div>
		</header>
	);
}

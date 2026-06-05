import { Separator } from "@base-ui/react/separator";
import { Cancel01Icon, MinusSignIcon, Settings05Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useCallback } from "react";
import { useTranslations } from "use-intl";
import { useConnectionStore } from "@/entities/connection";
import { HotkeyDisplay } from "@/features/push-to-talk";
import { windowClose, windowMinimize, windowOpenSettings } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { publicAsset } from "@/shared/lib/public-asset";
import { diagBeacon } from "@/shared/lib/winstt-diag";
import { SurfaceProvider, surfaceClasses, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { useTouchActivation } from "@/shared/lib/use-touch-activation";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";

function TitleBarActionButton({
	ariaLabel,
	children,
	className,
	onActivate,
}: {
	ariaLabel: string;
	children: ReactNode;
	className: string;
	onActivate: () => void;
}) {
	const activation = useTouchActivation(onActivate);
	return (
		<Button
			aria-label={ariaLabel}
			className={cn("titlebar-no-drag [touch-action:manipulation]", className)}
			{...activation}
		>
			{children}
		</Button>
	);
}

export function TitleBar() {
	const t = useTranslations("titleBar");
	const substrate = useSurface();
	const barLevel = Math.min(substrate + 1, 8);
	const hoverLevel = Math.min(barLevel + 2, 8);
	const isConnected = useConnectionStore((s) => s.connectionStatus) === "connected";
	const openSettings = useCallback(() => {
		diagBeacon("main", "settings button onClick fired");
		windowOpenSettings();
	}, []);

	return (
		<SurfaceProvider value={barLevel}>
			<header
				className={`titlebar-drag relative flex h-8 shrink-0 items-stretch border-border border-b ${surfaceClasses(barLevel, 1)}`}
			>
				{/* Left: Branding */}
				<div className="flex items-center pl-3">
					<img
						alt=""
						className="mr-1.5 size-4"
						draggable={false}
						height={16}
						src={publicAsset("/icon.ico")}
						width={16}
					/>
					<span className="font-mono font-semibold text-foreground-secondary text-xs-tight uppercase tracking-widest">
						{t("appName")}
					</span>
				</div>

				{/* Spacer - draggable area */}
				<div className="flex-1" />

				{/* Center: active hotkey, absolutely centred in the titlebar so it
				    stays at the true window midpoint regardless of the branding /
				    control widths. pointer-events-none lets drags + the window
				    controls behind it stay live; only the badge itself opts back in. */}
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
					<div className="titlebar-no-drag pointer-events-auto">
						<HotkeyDisplay isConnected={isConnected} side="bottom" />
					</div>
				</div>

				{/* Right: Settings gear + window controls */}
				<div className="titlebar-no-drag flex items-center">
					<Tooltip content={t("settings")}>
						<TitleBarActionButton
							ariaLabel={t("settings")}
							className={`flex h-full w-8 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 ${surfaceHoverBg(hoverLevel)} hover:text-foreground-secondary`}
							onActivate={openSettings}
						>
							<HugeiconsIcon icon={Settings05Icon} size={13} />
						</TitleBarActionButton>
					</Tooltip>
					<Separator className="h-3 w-px self-center bg-border" orientation="vertical" />
					<Tooltip content={t("minimize")}>
						<TitleBarActionButton
							ariaLabel={t("minimize")}
							className={`flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 ${surfaceHoverBg(hoverLevel)} hover:text-foreground-secondary`}
							onActivate={windowMinimize}
						>
							<HugeiconsIcon icon={MinusSignIcon} size={12} />
						</TitleBarActionButton>
					</Tooltip>
					<Tooltip content={t("close")}>
						<TitleBarActionButton
							ariaLabel={t("close")}
							className="flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 hover:bg-error hover:text-white"
							onActivate={windowClose}
						>
							<HugeiconsIcon icon={Cancel01Icon} size={12} />
						</TitleBarActionButton>
					</Tooltip>
				</div>
			</header>
		</SurfaceProvider>
	);
}

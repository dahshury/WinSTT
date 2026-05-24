import { Separator } from "@base-ui/react/separator";
import { Cancel01Icon, MinusSignIcon, Settings05Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { windowClose, windowMinimize, windowOpenSettings } from "@/shared/api/ipc-client";
import { SurfaceProvider, surfaceClasses, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";

export function TitleBar() {
	const t = useTranslations("titleBar");
	const substrate = useSurface();
	const barLevel = Math.min(substrate + 1, 8);
	const hoverLevel = Math.min(barLevel + 2, 8);

	return (
		<SurfaceProvider value={barLevel}>
			<header
				className={`titlebar-drag flex h-8 shrink-0 items-stretch border-border border-b ${surfaceClasses(barLevel, 1)}`}
			>
				{/* Left: Branding */}
				<div className="flex items-center pl-3">
					<img
						alt=""
						className="mr-1.5 size-4"
						draggable={false}
						height={16}
						src="/icon.ico"
						width={16}
					/>
					<span className="font-mono font-semibold text-foreground-secondary text-xs-tight uppercase tracking-widest">
						{t("appName")}
					</span>
				</div>

				{/* Spacer - draggable area */}
				<div className="flex-1" />

				{/* Right: Settings gear + window controls */}
				<div className="titlebar-no-drag flex items-center">
					<Tooltip content={t("settings")}>
						<Button
							aria-label={t("settings")}
							className={`flex h-full w-8 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 ${surfaceHoverBg(hoverLevel)} hover:text-foreground-secondary`}
							onClick={windowOpenSettings}
						>
							<HugeiconsIcon icon={Settings05Icon} size={13} />
						</Button>
					</Tooltip>
					<Separator className="h-3 w-px self-center bg-border" orientation="vertical" />
					<Tooltip content={t("minimize")}>
						<Button
							aria-label={t("minimize")}
							className={`flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 ${surfaceHoverBg(hoverLevel)} hover:text-foreground-secondary`}
							onClick={windowMinimize}
						>
							<HugeiconsIcon icon={MinusSignIcon} size={12} />
						</Button>
					</Tooltip>
					<Tooltip content={t("close")}>
						<Button
							aria-label={t("close")}
							className="flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 hover:bg-error hover:text-white"
							onClick={windowClose}
						>
							<HugeiconsIcon icon={Cancel01Icon} size={12} />
						</Button>
					</Tooltip>
				</div>
			</header>
		</SurfaceProvider>
	);
}

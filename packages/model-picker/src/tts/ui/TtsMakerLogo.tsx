import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { publicAsset } from "../../lib/public-asset";
import { getEngineConfig, getEngineLogoSrc, type TtsEngineKey } from "../lib/tts-helpers";

/**
 * The maker's brand logo for a TTS engine — a square `<img>` of the official
 * mark when the engine ships one, else the neutral gray glyph chip (same chrome
 * as `NeutralHeaderIcon`). One component shared by the card `makerIcon` slot,
 * the group header, and the trigger so the maker mark is identical everywhere.
 */
export function TtsMakerLogo({
	className,
	engine,
}: {
	className?: string;
	engine: TtsEngineKey | string;
}) {
	const logoSrc = getEngineLogoSrc(engine);
	if (logoSrc) {
		return (
			<img
				alt=""
				className={cn("size-4 shrink-0 rounded-[4px] object-cover", className)}
				height={16}
				src={publicAsset(logoSrc)}
				width={16}
			/>
		);
	}
	return (
		<span
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded bg-foreground/[0.06] text-foreground-muted",
				className
			)}
		>
			<HugeiconsIcon className="size-3" icon={getEngineConfig(engine).icon} />
		</span>
	);
}

import { HugeiconsIcon } from "@hugeicons/react";
import { publicAsset } from "@/shared/lib/public-asset";
import { MakerLogo } from "../../ui/MakerLogo";
import {
	getEngineConfig,
	getEngineLogoSrc,
	type TtsEngineKey,
} from "../lib/tts-helpers";

/**
 * The maker's brand logo for a TTS engine — the official mark when the engine
 * ships one, else the neutral gray glyph chip. A thin wrapper over the shared
 * {@link MakerLogo} so the card `makerIcon` slot, the group header, and the
 * trigger render the maker mark identically to the STT and Ollama pickers.
 */
export function TtsMakerLogo({
	className,
	engine,
}: {
	className?: string;
	engine: TtsEngineKey | string;
}) {
	const logoSrc = getEngineLogoSrc(engine);
	return (
		<MakerLogo
			className={className}
			fallback={
				<HugeiconsIcon className="size-3" icon={getEngineConfig(engine).icon} />
			}
			src={logoSrc ? publicAsset(logoSrc) : null}
		/>
	);
}

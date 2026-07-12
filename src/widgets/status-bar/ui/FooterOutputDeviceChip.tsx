import { Button as BaseButton } from "@base-ui/react/button";
import { ArrowDown01Icon, Speaker01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { useListenStore } from "@/features/listen-mode";
import { surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Tooltip } from "@/shared/ui/tooltip";
import { abbreviateDevice } from "../lib/device-name";
import { FOOTER_TOOLTIP_DELAY } from "./FooterMenuChip";
import {
	MODEL_PICKER_TRIGGER_SLOT,
	useModelPickerTrigger,
} from "./footer-model-picker-trigger";

/**
 * Listen-mode output-device chip in the footer. Replaces the old static device
 * label with a real picker trigger: clicking it opens the detached
 * output-device picker (hosted in the shared model-picker backdrop window so the
 * device list escapes the tiny main window). Styled identically to the
 * input-device chip (`FooterMenuChip`) — same monochrome icon · name · chevron,
 * no coloured "listening" accent — so the two device pickers read as one. The
 * name is the live listened device (updated by `stt:loopback-started`), falling
 * back to the idle label before capture starts.
 */
export function FooterOutputDeviceChip(): ReactNode {
	const t = useTranslations("statusBar");
	const tAudio = useTranslations("audio");
	const isListening = useListenStore((s) => s.isListening);
	const listenDeviceName = useListenStore((s) => s.deviceName);
	const substrate = useSurface();
	const hoverLevel = Math.min(substrate + 2, 8);
	const openPicker = useModelPickerTrigger("output-device");
	const label = listenDeviceName
		? abbreviateDevice(listenDeviceName)
		: t("loopbackIdle");

	return (
		<Tooltip
			content={
				isListening ? t("loopbackActiveTooltip") : t("loopbackIdleTooltip")
			}
			delay={FOOTER_TOOLTIP_DELAY}
			side="top"
		>
			<BaseButton
				aria-label={tAudio("outputDevice")}
				className={`flex max-w-[180px] cursor-pointer select-none items-center gap-1 rounded-xs bg-transparent px-1 py-[1px] text-2xs text-foreground-secondary outline-none transition-colors ${surfaceHoverBg(hoverLevel)} focus-visible:ring-1 focus-visible:ring-accent`}
				data-slot={MODEL_PICKER_TRIGGER_SLOT}
				onClick={openPicker}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					color="var(--color-foreground-dim)"
					icon={Speaker01Icon}
					size={11}
				/>
				<span className="min-w-0 truncate">{label}</span>
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-dim"
					icon={ArrowDown01Icon}
					size={11}
				/>
			</BaseButton>
		</Tooltip>
	);
}

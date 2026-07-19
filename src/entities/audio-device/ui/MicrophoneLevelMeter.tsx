import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import {
	METER_FULL_SCALE,
	METER_SEGMENTS,
} from "./microphone-level-meter.constants";
import type { MicrophoneLevelMeterProps } from "./microphone-level-meter.types";

export function MicrophoneLevelMeter({
	active,
	level,
}: MicrophoneLevelMeterProps) {
	const substrate = useSurface();
	const trackLevel = Math.min(substrate + (active ? 2 : 1), 8);
	const normalized = Math.min(
		1,
		Math.sqrt(Math.max(0, level) / METER_FULL_SCALE),
	);
	const filled = normalized * METER_SEGMENTS;
	return (
		<span
			aria-hidden="true"
			data-slot="microphone-level-meter"
			className={cn(
				"flex h-[22px] w-[18px] shrink-0 flex-col-reverse justify-center gap-[2px]",
				active ? "opacity-100" : "opacity-90",
			)}
		>
			{Array.from({ length: METER_SEGMENTS }, (_, i) => {
				const amount = Math.max(0, Math.min(1, filled - i));
				return (
					<span
						className={cn(
							"block h-[2px] w-full overflow-hidden rounded-full ring-1 ring-divider-strong ring-inset",
							surfaceBg(trackLevel),
						)}
						data-slot="microphone-level-meter-segment"
						key={`meter-${i}`}
					>
						<span
							className="block h-full rounded-full bg-accent shadow-[0_0_6px_var(--color-accent-glow-strong)] transition-transform duration-75 ease-linear"
							data-slot="microphone-level-meter-fill"
							style={{
								opacity: amount > 0 ? 1 : 0,
								transform: `scaleX(${amount})`,
								transformOrigin: "right center",
							}}
						/>
					</span>
				);
			})}
		</span>
	);
}

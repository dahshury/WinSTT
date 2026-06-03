import { Tooltip } from "@base-ui/react/tooltip";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { useSettingsStore } from "@/entities/setting";
import { RestartRequiredToast } from "@/features/restart-notice";
import { CloudKeyRevertNotice } from "@/features/revert-cloud-on-key-removal";
import { CloudSttErrorToasts } from "@/features/show-cloud-stt-errors";
import { SwapFailureToast } from "@/features/swap-notifications";
import { TransformToast } from "@/features/transform-notifications";
import { SurfaceProvider } from "@/shared/lib/surface";
import { IntlProvider } from "../providers/IntlProvider";
import { IpcProvider } from "../providers/IpcProvider";
import { TitleBar } from "./TitleBar";

export function RootLayout({ children }: { children: ReactNode }) {
	const isListenMode = useSettingsStore((s) => s.settings.general?.recordingMode) === "listen";

	return (
		<IntlProvider>
			{/* `reducedMotion="user"` makes every JS-driven framer-motion animation
			    (incl. the looping visualizer / dynamic-island loops) honor the OS
			    prefers-reduced-motion setting app-wide. */}
			<MotionConfig reducedMotion="user">
				<Tooltip.Provider closeDelay={0} delay={400}>
					<IpcProvider>
						<SurfaceProvider value={1}>
							<div className="noise-overlay flex h-screen flex-col bg-surface-1">
								{!isListenMode && <TitleBar />}
								<main className="flex-1 overflow-hidden">{children}</main>
								<TransformToast />
								<SwapFailureToast />
								<RestartRequiredToast />
								<CloudSttErrorToasts />
								<CloudKeyRevertNotice />
							</div>
						</SurfaceProvider>
					</IpcProvider>
				</Tooltip.Provider>
			</MotionConfig>
		</IntlProvider>
	);
}

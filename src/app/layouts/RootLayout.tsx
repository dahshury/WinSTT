import { Tooltip } from "@base-ui/react/tooltip";
import { domAnimation, LazyMotion, m, MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { useVisualizerStore } from "@/features/audio-visualizer";
import { shouldUseListenSurface } from "@/features/listen-mode";
import { CloudKeyRevertNotice } from "@/features/revert-cloud-on-key-removal";
import { CloudSttErrorToasts } from "@/features/show-cloud-stt-errors";
import { SwapFailureToast } from "@/features/swap-notifications";
import { TransformToast } from "@/features/transform-notifications";
import { SurfaceProvider } from "@/shared/lib/surface";
import { IntlProvider } from "../providers/IntlProvider";
import { IpcProvider } from "../providers/IpcProvider";
import { TitleBar } from "./TitleBar";

export function RootLayout({ children }: { children: ReactNode }) {
	const isListenMode =
		useSettingsStore((s) => s.settings.general?.recordingMode) === "listen";
	const audioLevel = useVisualizerStore((s) => s.audioLevel);
	const isSpeaking = useVisualizerStore((s) => s.isSpeaking);
	const liveText = useTranscriptionStore((s) => s.currentRealtime);
	const hasEphemeral = useTranscriptionStore((s) => s.ephemeral !== null);
	const listenSurfaceActive = shouldUseListenSurface({
		audioLevel,
		hasEphemeral,
		isListenMode,
		isSpeaking,
		liveText,
	});

	return (
		<IntlProvider>
			{/* `reducedMotion="user"` makes every JS-driven framer-motion animation
			    (incl. the looping visualizer / dynamic-island loops) honor the OS
			    prefers-reduced-motion setting app-wide. */}
			<MotionConfig reducedMotion="user">
				<Tooltip.Provider closeDelay={0} delay={400}>
					<IpcProvider>
						<SurfaceProvider value={1}>
							<LazyMotion features={domAnimation} strict>
								<m.div
									animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
									className="noise-overlay flex h-screen flex-col bg-surface-1"
									initial={{ opacity: 0, y: 6, filter: "blur(2px)" }}
									transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
								>
									{!listenSurfaceActive && <TitleBar />}
									<main className="flex-1 overflow-hidden">{children}</main>
									<TransformToast />
									<SwapFailureToast />
									<CloudSttErrorToasts />
									<CloudKeyRevertNotice />
								</m.div>
							</LazyMotion>
						</SurfaceProvider>
					</IpcProvider>
				</Tooltip.Provider>
			</MotionConfig>
		</IntlProvider>
	);
}

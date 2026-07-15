import { Tooltip } from "@base-ui/react/tooltip";
import { domAnimation, LazyMotion, MotionConfig, m } from "motion/react";
import type { ReactNode } from "react";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { useVisualizerStore } from "@/features/audio-visualizer";
import { shouldUseListenSurface } from "@/features/listen-mode";
import { useAfterFirstPaint } from "@/shared/lib/use-after-first-paint";
import { springs } from "@/shared/lib/springs";
import { SurfaceProvider } from "@/shared/lib/surface";
import { ErrorBoundary } from "../providers/ErrorBoundary";
import { IntlProvider } from "../providers/IntlProvider";
import { IpcProvider } from "../providers/IpcProvider";
import { DeferredMainSurfaces } from "./DeferredMainSurfaces";
import { TitleBar } from "./TitleBar";

export function RootLayout({ children }: { children: ReactNode }) {
	const afterFirstPaint = useAfterFirstPaint();
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
									transition={springs.slow}
								>
									{!listenSurfaceActive && <TitleBar />}
									<main className="flex-1 overflow-hidden">
										<ErrorBoundary>{children}</ErrorBoundary>
									</main>
									{afterFirstPaint ? <DeferredMainSurfaces /> : null}
								</m.div>
							</LazyMotion>
						</SurfaceProvider>
					</IpcProvider>
				</Tooltip.Provider>
			</MotionConfig>
		</IntlProvider>
	);
}

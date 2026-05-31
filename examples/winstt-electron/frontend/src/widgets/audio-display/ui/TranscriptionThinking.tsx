import { AnimatePresence, domAnimation, LazyMotion, m } from "motion/react";
import { useLlmProcessingStore } from "@/features/llm-processing";
import { ThinkingIndicator } from "@/shared/ui/thinking-indicator";

/**
 * Main-window twin of the pill's thinking state.
 *
 * While the dictation LLM is reasoning, the main window's transcription
 * surface shows the *same* indicator + streamed thinking tokens the pill
 * shows (driven by the shared LLM-processing store, fed via
 * `useLlmProcessingFeed` in `IpcProvider`). The final processed sentence is
 * deliberately NOT streamed here — it arrives once via `STT_FULL_SENTENCE`
 * and renders through `SubtitleOverlay` like always — so this layer only
 * fills the think → paste gap, matching how the pill behaves.
 *
 * Rendered as a centered, click-through overlay so it visually takes over
 * the subtitle area the way the pill's bubble swaps text for thinking.
 */
export function TranscriptionThinking() {
	const isThinking = useLlmProcessingStore((s) => s.isThinking);
	const thinkingText = useLlmProcessingStore((s) => s.thinkingText);
	const thinkingStartedAt = useLlmProcessingStore((s) => s.thinkingStartedAt);

	return (
		<LazyMotion features={domAnimation} strict>
			<AnimatePresence>
				{isThinking && (
					<m.div
						animate={{ opacity: 1 }}
						className="pointer-events-none absolute inset-0 z-overlay flex items-center justify-center px-4"
						exit={{ opacity: 0, transition: { duration: 0.12 } }}
						initial={{ opacity: 0 }}
						key="main-thinking"
					>
						<div className="relative inline-flex max-w-[460px] flex-col items-center overflow-hidden rounded-2xl bg-gradient-to-b from-[var(--color-surface-3)]/65 to-[var(--color-surface-1)]/92 px-3 py-2 ring-1 ring-white/[0.08] ring-inset backdrop-blur-md backdrop-saturate-150">
							{/* Brand-accent hairline — mirrors the pill bubble's top edge. */}
							<div
								aria-hidden="true"
								className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-[oklch(62%_0.19_260/0.5)] to-transparent"
							/>
							<ThinkingIndicator reasoning={thinkingText} startedAt={thinkingStartedAt} />
						</div>
					</m.div>
				)}
			</AnimatePresence>
		</LazyMotion>
	);
}

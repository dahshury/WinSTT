import { domMax, LazyMotion } from "motion/react";
import {
	DynamicIsland,
	DynamicIslandProvider,
	type DynamicIslandSize,
} from "@/shared/ui/dynamic-island";
import { ThinkingIndicator } from "@/shared/ui/thinking-indicator";
import {
	OVERLAY_PANEL_CLOSE_MS,
	TRANSFORMING_WORDS,
	useDelayedUnmount,
} from "./overlay-shell.shared";

function DynamicTransformIslandPill({
	revealed,
	thinkingText,
	transformStartedAt,
}: {
	revealed: boolean;
	thinkingText: string;
	transformStartedAt: number | null;
}) {
	const target: DynamicIslandSize = revealed ? "compactMedium" : "empty";
	const renderContent = useDelayedUnmount(revealed, OVERLAY_PANEL_CLOSE_MS);

	return (
		<DynamicIsland
			data-overlay-hit-region="true"
			fitContent
			flatTop
			id="winstt-overlay-island"
			size={target}
		>
			{renderContent ? (
				<div
					className="px-5 pt-2 pb-3"
					data-overlay-processing-content="true"
					data-overlay-processing-kind="transform"
					data-overlay-transform-content="true"
				>
					<ThinkingIndicator
						fluidWidth
						reasoning={thinkingText}
						reserveDefaultWords
						startedAt={transformStartedAt}
						words={TRANSFORMING_WORDS}
					/>
				</div>
			) : null}
		</DynamicIsland>
	);
}

function DynamicTransformIslandLayer({
	show,
	thinkingText,
	transformStartedAt,
}: {
	show: boolean;
	thinkingText: string;
	transformStartedAt: number | null;
}) {
	return (
		<LazyMotion features={domMax} strict>
			<div className="flex h-screen w-screen items-start justify-center overflow-hidden">
				<DynamicIslandProvider initialSize="empty">
					<DynamicTransformIslandPill
						revealed={show}
						thinkingText={thinkingText}
						transformStartedAt={transformStartedAt}
					/>
				</DynamicIslandProvider>
			</div>
		</LazyMotion>
	);
}

export { DynamicTransformIslandLayer };

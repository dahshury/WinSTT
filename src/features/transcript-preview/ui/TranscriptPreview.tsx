import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { cancelPreview } from "@/shared/api/ipc-client";
import { SurfaceProvider } from "@/shared/lib/surface";
import { useEscapeToClose } from "@/shared/lib/window-effects";
import { IconButton } from "@/shared/ui/icon-button";
import { useTranscriptPreviewStore } from "../model/preview-store";
import { EditView } from "./EditView";
import { EnhanceView } from "./EnhanceView";

/**
 * The preview-before-pasting pill content. Rendered inside both the dynamic
 * island and the floating-bottom bubble when `isPreviewActive`. A small view
 * state machine (edit ⇄ enhance) that morphs the pill height (the shells animate
 * height as a CSS property — no `layout` distortion). The enhance view is a
 * split layout: top = the transcript (or the AI-edit diff to accept/deny),
 * bottom = the AI controls. Wrapped in a `SurfaceProvider` so the surfaces
 * system elevates panels correctly against the island's near-black shell.
 */
export function TranscriptPreview() {
	const tp = useTranslations("preview");
	const view = useTranscriptPreviewStore((s) => s.view);
	const reset = useTranscriptPreviewStore((s) => s.reset);

	const dismiss = () => {
		void cancelPreview();
		reset();
	};
	useEscapeToClose(dismiss);

	return (
		<SurfaceProvider value={2}>
			<div className="pointer-events-auto relative w-[600px] max-w-full px-3 pt-2 pb-3 text-left">
				<div className="absolute top-1.5 right-2 z-raised">
					<IconButton
						aria-label={tp("dismiss")}
						icon={<HugeiconsIcon icon={Cancel01Icon} size={14} />}
						onClick={dismiss}
					/>
				</div>
				{/* `key={view}` remounts on view change → the StaggerReveal replays and
            the shell's fitContent height tweens to the new content. */}
				<div key={view}>
					{view === "edit" ? <EditView /> : null}
					{view === "enhance" ? <EnhanceView /> : null}
				</div>
			</div>
		</SurfaceProvider>
	);
}

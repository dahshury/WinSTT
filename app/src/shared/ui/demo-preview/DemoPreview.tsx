import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { type ReactElement, useState } from "react";
import { type DemoName, demoPreviewUrl } from "@/shared/config/demo-preview";
import { Z_INDEX } from "@/shared/config/z-index";

interface DemoPreviewProps {
	/**
	 * The feature's own control to wrap as the hover/focus target — e.g. a
	 * single switcher option button. The preview attaches directly to it, so the
	 * demo reveals on hovering the actual button. There is no standalone trigger
	 * or arrow: a preview always lives on the control it documents.
	 */
	children: ReactElement;
	/** Demo clip name — resolved to a remote .webm on the docs CDN. */
	demo: DemoName;
	side?: "top" | "bottom" | "left" | "right";
}

function startsOffline(): boolean {
	return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Reveals a short looping demo of a feature when its own control is
 * hovered/focused. The clip is fetched on demand from the public docs site (a
 * CDN) — never bundled in the installer.
 *
 * It always wraps the feature's actual control (`children`) — never a separate
 * play button/arrow. When there's no connection (or the clip can't be fetched)
 * the preview is simply omitted and the child renders as-is: an unavailable
 * preview stays silent rather than nagging.
 */
export function DemoPreview({ demo, side = "top", children }: DemoPreviewProps) {
	// Seed from navigator.onLine so a definitely-offline session never flashes an
	// empty popup; the <video> onError covers the online-but-unreachable case.
	const [failed, setFailed] = useState(startsOffline);

	if (failed) {
		return children;
	}

	return (
		<TooltipPrimitive.Root>
			<TooltipPrimitive.Trigger render={children} />
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Positioner side={side} sideOffset={8} style={{ zIndex: Z_INDEX.tooltip }}>
					<TooltipPrimitive.Popup className="origin-(--transform-origin) overflow-hidden rounded-xl border border-border bg-surface-2 shadow-[0_12px_32px_-12px_rgba(2,3,8,0.7)] transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
						<video
							aria-label={`${demo} demo`}
							autoPlay
							className="block w-[300px]"
							loop
							muted
							onError={() => setFailed(true)}
							playsInline
							src={demoPreviewUrl(demo)}
							tabIndex={-1}
						>
							<track kind="captions" />
						</video>
					</TooltipPrimitive.Popup>
				</TooltipPrimitive.Positioner>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}

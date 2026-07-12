"use client";

import { PreviewCard } from "@base-ui/react/preview-card";
import { cloneElement, type ReactElement } from "react";
import { Z_INDEX } from "@/shared/config/z-index";
import { SurfaceProvider, surfaceClasses } from "@/shared/lib/surface";
import { ModelSpecCard } from "./ModelSpecCard";
import { InsideModelSpecHoverCardProvider } from "./spec-hover-context";
import type { ModelSpec } from "./types";

/**
 * Level 7 — the same fixed surface the app-wide tooltip pins to (see
 * `shared/ui/tooltip`). Transient topmost chrome reads consistently regardless
 * of the substrate it floats over, and the level-7 shadow recipe supplies the
 * hairline outline + top highlight.
 */
const POPUP_LEVEL = 7;

/**
 * Open only after a deliberate hover — the card must NOT flash on every mouse
 * pass over the selector. ~0.45s reads as "the user paused here on purpose".
 */
const DEFAULT_OPEN_DELAY = 450;
/** Short close grace so the pointer can travel from trigger into the card. */
const CLOSE_DELAY = 120;

export interface ModelSpecHoverCardProps {
	/** The normalized spec to render. When `null`/`undefined` the wrapper is inert
	 *  and just renders `children` (no hover behaviour) — e.g. no model selected. */
	spec: ModelSpec | null | undefined;
	/**
	 * The anchor. MUST be a single DOM element (not a bare component) so Base UI
	 * can merge the hover handlers + ref onto it — mirrors the shared Tooltip's
	 * `cloneElement` contract. Callers wrap the selected-model summary in a
	 * `<span>`/`<div>` and pass that.
	 */
	children: ReactElement;
	/** Open delay in ms. */
	delay?: number;
	side?: "top" | "bottom" | "left" | "right";
	align?: "start" | "center" | "end";
	sideOffset?: number;
}

/**
 * Wraps a model-selector's selected-model chip so that hovering it (after a
 * short delay) reveals a rich {@link ModelSpecCard}. Built on Base UI's
 * PreviewCard (hover-card) primitive: it opens on hover only — never on the
 * click that opens the picker popup, and never on keyboard focus — so tabbing
 * through settings stays quiet. The popup is interactive (the pointer can move
 * into it, e.g. to read the full description).
 */
export function ModelSpecHoverCard({
	spec,
	children,
	delay = DEFAULT_OPEN_DELAY,
	side = "top",
	align = "center",
	sideOffset = 8,
}: ModelSpecHoverCardProps) {
	if (!spec) {
		return children;
	}
	return (
		<InsideModelSpecHoverCardProvider value={true}>
			<PreviewCard.Root>
				<PreviewCard.Trigger
					closeDelay={CLOSE_DELAY}
					delay={delay}
					render={cloneElement(children, {
						suppressHydrationWarning: true,
					} as Record<string, unknown>)}
				/>
				<PreviewCard.Portal>
					<SurfaceProvider value={POPUP_LEVEL}>
						<PreviewCard.Positioner
							align={align}
							collisionPadding={12}
							side={side}
							sideOffset={sideOffset}
							style={{ zIndex: Z_INDEX.tooltip }}
						>
							<PreviewCard.Popup
								className={`w-[340px] max-w-[92vw] origin-(--transform-origin) overflow-hidden rounded-xl ${surfaceClasses(POPUP_LEVEL)} font-sans transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[instant]:transition-none`}
							>
								<ModelSpecCard spec={spec} />
							</PreviewCard.Popup>
						</PreviewCard.Positioner>
					</SurfaceProvider>
				</PreviewCard.Portal>
			</PreviewCard.Root>
		</InsideModelSpecHoverCardProvider>
	);
}

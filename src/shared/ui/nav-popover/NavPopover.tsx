"use client";

import { Popover } from "@base-ui/react/popover";
import {
	type ComponentPropsWithoutRef,
	type KeyboardEvent,
	type ReactElement,
	type ReactNode,
	type RefObject,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceBg, useSurface } from "@/shared/lib/surface";
import { focusNavRow, focusViewInitialTarget } from "./focus-view";
import { NavPopoverHeader } from "./NavPopoverHeader";
import { NavPopoverStage } from "./NavPopoverStage";
import { useViewStack } from "./use-view-stack";

export interface NavPopoverView {
	/** Matches the `viewId` of the row that opens it. */
	id: string;
	render: () => ReactNode;
	/** Caption of the back button while this view is on screen. */
	title: string;
	/** Overrides the popover's base width for this view only. */
	widthPx?: number | undefined;
}

/**
 * Imperative escape hatch for hosts that must open a specific view from outside
 * the popover — the data grid's Ctrl+Shift+F / Ctrl+Shift+S shortcuts, which
 * used to each own a separate menu and must still land on their own dimension.
 */
export interface NavPopoverHandle {
	close: () => void;
	/** Open (or stay open) showing `viewId`, replacing any current view. */
	openAt: (viewId: string) => void;
	/** Same, but a second press on the same view closes the popover. */
	toggleAt: (viewId: string) => void;
}

/** Text-entry targets where ArrowLeft means "move the caret", not "go back". */
function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/**
 * A popover whose contents are a small navigable hierarchy rather than one long
 * panel: a root list of rows, each drilling into a focused view for exactly one
 * decision. The frame eases between view sizes and cross-slides them, so depth
 * is communicated by motion instead of by a scrollbar.
 *
 * Keyboard model, which is the point of the pattern:
 *   Up/Down   move between rows          (see `NavList`)
 *   Right/Enter  drill into a row
 *   Left      back one level (unless a text field wants the key)
 *   Escape    back one level, and only closes once at the root
 *
 * Focus follows the same hierarchy: drilling in lands on the view's own initial
 * target (`data-nav-initial-focus`) or its back button, and backing out returns
 * to the row that opened it, so the popover never dumps focus at the top.
 */
export function NavPopover({
	dataSlot,
	handleRef,
	renderRoot,
	rootTitle,
	rootTrailing,
	trigger,
	views,
	widthPx,
}: {
	dataSlot: string;
	/** Filled with a {@link NavPopoverHandle} while mounted, for hosts that open
	 *  a specific view from a keyboard shortcut. */
	handleRef?: RefObject<NavPopoverHandle | null> | undefined;
	/** The root list. `push` opens the view whose `id` matches. */
	renderRoot: (push: (viewId: string) => void) => ReactNode;
	rootTitle: string;
	/** Trailing action on the root header — the filter menus put "Clear all"
	 *  here. Hidden inside sub-views, where it would be ambiguous. */
	rootTrailing?: ReactNode;
	trigger: (props: ComponentPropsWithoutRef<"button">) => ReactElement;
	views: readonly NavPopoverView[];
	widthPx: number;
}) {
	const level = Math.min(useSurface() + 1, 8);
	const [open, setOpen] = useState(false);
	const nav = useViewStack();
	const popupRef = useRef<HTMLDivElement>(null);
	const returnFocusRef = useRef<string | null>(null);

	const activeView = views.find((view) => view.id === nav.activeId) ?? null;
	// A stale id (a section pruned while its view was open) falls back to root
	// rather than rendering an empty frame.
	const activeKey = activeView?.id ?? "__root__";

	const push = (viewId: string) => {
		returnFocusRef.current = viewId;
		nav.push(viewId);
	};

	// Reassigned on every commit so the handle always closes over fresh state;
	// there is no dependency list that would stay correct otherwise.
	useLayoutEffect(() => {
		if (handleRef === undefined) {
			return;
		}
		handleRef.current = {
			close: () => setOpen(false),
			openAt: (viewId: string) => {
				returnFocusRef.current = viewId;
				nav.replace(viewId);
				setOpen(true);
			},
			toggleAt: (viewId: string) => {
				if (open && nav.activeId === viewId) {
					setOpen(false);
					return;
				}
				returnFocusRef.current = viewId;
				nav.replace(viewId);
				setOpen(true);
			},
		};
		return () => {
			handleRef.current = null;
		};
	});

	useLayoutEffect(() => {
		const popup = popupRef.current;
		if (popup === null || !open) {
			return;
		}
		if (activeKey === "__root__") {
			const viewId = returnFocusRef.current;
			returnFocusRef.current = null;
			if (viewId !== null) {
				focusNavRow(popup, viewId);
			}
			return;
		}
		focusViewInitialTarget(popup);
	}, [activeKey, open]);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key === "ArrowLeft" &&
			nav.depth > 0 &&
			!isTextEntry(event.target)
		) {
			event.preventDefault();
			nav.back();
		}
	};

	return (
		<Popover.Root
			onOpenChange={(nextOpen, details) => {
				// Escape unwinds the hierarchy one level at a time; only an Escape
				// at the root is allowed to dismiss the popover.
				if (!nextOpen && details.reason === "escape-key" && nav.depth > 0) {
					details.cancel();
					nav.back();
					return;
				}
				setOpen(nextOpen);
			}}
			onOpenChangeComplete={(nextOpen) => {
				// Reset after the close animation, not during it — resetting early
				// would slide the root back in while the popover is fading out.
				if (!nextOpen) {
					nav.reset();
					returnFocusRef.current = null;
				}
			}}
			open={open}
		>
			<Popover.Trigger
				nativeButton
				render={(props) => trigger(props as ComponentPropsWithoutRef<"button">)}
			/>
			<Popover.Portal>
				<Popover.Positioner
					align="end"
					sideOffset={6}
					style={{ zIndex: Z_INDEX.popover }}
				>
					<Popover.Popup
						className={cn(
							"select-popup origin-(--transform-origin) overflow-hidden rounded-md border border-border font-sans text-body text-foreground shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in",
							surfaceBg(level),
						)}
						data-slot={dataSlot}
						onKeyDown={onKeyDown}
						ref={popupRef}
					>
						<SurfaceProvider value={level}>
							<NavPopoverStage
								activeKey={activeKey}
								direction={nav.direction}
								widthPx={activeView?.widthPx ?? widthPx}
							>
								{activeView === null ? (
									<div className="p-1">
										<NavPopoverHeader
											title={rootTitle}
											trailing={rootTrailing}
										/>
										{renderRoot(push)}
									</div>
								) : (
									<div className="p-1">
										<NavPopoverHeader
											backLabel={`Back to ${rootTitle}`}
											onBack={nav.back}
											title={activeView.title}
										/>
										{activeView.render()}
									</div>
								)}
							</NavPopoverStage>
						</SurfaceProvider>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

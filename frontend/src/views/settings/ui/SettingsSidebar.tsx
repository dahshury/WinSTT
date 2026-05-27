import { Tabs } from "@base-ui/react/tabs";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { SurfaceProvider, surfaceBg, useSurface } from "@/shared/lib/surface";
import { Tooltip } from "@/shared/ui/tooltip";

/**
 * Rail-tuned divider. The card `TextureSeparator` stacks a dark
 * (`surface-1`) hairline that disappears on the dark rail, so this mirrors
 * the rail's own edge treatment instead: a `divider-strong` line lifted by
 * a faint top-light highlight — etched, and actually visible here.
 */
function RailSeparator() {
	return (
		<div
			aria-hidden="true"
			className="relative h-px w-full bg-[var(--color-divider-strong)] shadow-[0_1px_0_0_oklch(100%_0_0_/_0.05)]"
		/>
	);
}

export interface SidebarLink {
	/** Render a separator after this row to close a logical tab group */
	groupEnd?: boolean;
	icon: IconSvgElement;
	key: string;
	label: string;
	/** Tooltip explaining what the tab configures */
	tooltip?: string;
}

interface SettingsSidebarProps {
	links: SidebarLink[];
}

/**
 * Internal spacing uses fixed px rather than rem because the root font-size
 * is 14px (not 16px), so em-based math would mis-center the icon column.
 *
 * SIDE_PAD      = 10px            → tab list horizontal padding
 * ICON_COL      = 40px            → icon column width (keeps the 28px badge
 *                                   optically centred in the 60px rail)
 * BADGE_SIZE    = 28px            → a quiet container, not a tile — small
 *                                   enough that it doesn't crowd the label
 * COLLAPSED     = 60px            → SIDE_PAD*2 + ICON_COL
 * EXPANDED      = 196px           → leaves ~136px for the label
 *
 * One easing curve (expo-out) drives width, label and badge so the rail
 * moves as a single object — the spring "settles" rather than several
 * elements arriving on different timelines. No glow / no coloured pill:
 * the active row is marked the same clean, embossed way SettingSection
 * marks itself (accent badge + faint wash + inset hairline).
 */
const SIDE_PAD = 10;
const ICON_COL = 40;
const BADGE_SIZE = 28;
const COLLAPSED_WIDTH = 60;
const EXPANDED_WIDTH = 196;
const ROW_HEIGHT = 40;
const SPRING = "cubic-bezier(0.16, 1, 0.3, 1)";

/**
 * On touch devices the hover-to-expand affordance never fires (no mouseenter
 * before the tap), so the sidebar would stay collapsed forever and the user
 * would have to guess which icon is which. Detect any coarse pointer and
 * keep the rail open so labels are always readable on tap-driven hardware.
 */
function useCoarsePointer(): boolean {
	const [coarse, setCoarse] = useState(false);
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
			return;
		}
		const mql = window.matchMedia("(any-pointer: coarse)");
		setCoarse(mql.matches);
		const handler = (e: MediaQueryListEvent) => setCoarse(e.matches);
		mql.addEventListener("change", handler);
		return () => mql.removeEventListener("change", handler);
	}, []);
	return coarse;
}

export function SettingsSidebar({ links }: SettingsSidebarProps) {
	const isCoarsePointer = useCoarsePointer();
	const [hoverExpanded, setHoverExpanded] = useState(false);
	const expanded = isCoarsePointer || hoverExpanded;
	const setExpanded = setHoverExpanded;

	// Substrate is the page (surface-1). The rail lifts +1 to mirror the
	// content viewport.
	const substrate = useSurface();
	const railLevel = Math.min(substrate + 1, 8);

	// Label / wordmark reveal: slide + fade, staggered so the rail "unfurls"
	// from the top. Kept mounted (no display:none) so labels stay in the
	// accessibility tree even while collapsed.
	const revealStyle = (index: number) => ({
		opacity: expanded ? 1 : 0,
		transform: expanded ? "translateX(0)" : "translateX(-6px)",
		transition: `opacity 220ms ${SPRING} ${expanded ? 40 + index * 18 : 0}ms, transform 260ms ${SPRING} ${expanded ? 40 + index * 18 : 0}ms`,
	});

	return (
		<SurfaceProvider value={railLevel}>
			{/* Flow spacer — reserves a constant collapsed-width column so the
			    content viewport never reflows when the rail expands. The rail
			    itself is absolutely positioned and overlays the content on
			    hover/focus, so a wide control (e.g. the recording-mode
			    Switcher) is never squeezed/clipped by a transient hover.
			    On touch devices the rail is permanently expanded (no hover to
			    trigger it), so the spacer matches expanded width — otherwise
			    the rail would float over the content and obscure the first
			    136px of every panel. */}
			<div
				className="relative h-full shrink-0"
				style={{ width: isCoarsePointer ? EXPANDED_WIDTH : COLLAPSED_WIDTH }}
			>
				{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: sidebar wrapper uses focus/hover events to drive visual expansion only */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: sidebar wrapper uses focus/hover events to drive visual expansion only */}
				<div
					className={`absolute inset-y-0 left-0 z-overlay flex h-full flex-col overflow-hidden ${surfaceBg(railLevel)} shadow-[inset_-1px_0_0_0_var(--color-divider-strong),inset_0_1px_0_0_oklch(100%_0_0_/_0.04)] transition-[width] duration-[280ms] ease-[cubic-bezier(0.16,1,0.3,1)]`}
					onBlur={(e) => {
						if (!e.currentTarget.contains(e.relatedTarget)) {
							setExpanded(false);
						}
					}}
					onFocus={(e) => {
						// Only expand for keyboard-driven focus. Mouse clicks and
						// window-focus-restoration (e.g. clicking the taskbar to
						// bring the app forward) also land focus on the last-active
						// Tab in this rail — without the :focus-visible gate the
						// sidebar would auto-open every time the user came back to
						// the window.
						const target = e.target as Element | null;
						if (target?.matches?.(":focus-visible")) {
							setExpanded(true);
						}
					}}
					onMouseEnter={() => setExpanded(true)}
					onMouseLeave={() => setExpanded(false)}
					style={{ width: expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH }}
				>
					{/* Atmosphere — same brand vocabulary as the settings titlebar:
				    an accent hairline kissing the top edge and a soft top-light
				    wash, plus a faint bottom vignette so the rail reads as a
				    grounded column rather than a floating strip. */}
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-0 top-0 z-raised h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent"
					/>
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-[var(--color-surface-3)]/40 to-transparent"
					/>
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-surface-1/35 to-transparent"
					/>

					<RailSeparator />

					{/* Tab list */}
					<Tabs.List
						className="relative flex flex-1 flex-col gap-1 py-3"
						style={{ paddingInline: SIDE_PAD }}
					>
						{links.map((link, index) => {
							const tab = (
								<Tabs.Tab
									className="group relative flex w-full cursor-pointer items-center rounded-md border-0 bg-transparent p-0 outline-none transition-[background-color,box-shadow] duration-200 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 data-[active]:bg-accent/[0.06] data-[active]:shadow-[inset_0_0_0_1px_var(--color-divider-strong)]"
									key={link.key}
									style={{ height: ROW_HEIGHT }}
									value={link.key}
								>
									<span
										aria-hidden="true"
										className="flex shrink-0 items-center justify-center"
										style={{ width: ICON_COL, height: ROW_HEIGHT }}
									>
										{/* Icon badge — SettingSection's accent-badge
									    vocabulary, scaled down to a quiet marker:
									    transparent until active, then a soft
									    accent wash + text-accent + a single
									    inset hairline. No glow, no scale jump —
									    the same clean, embossed way the section
									    header marks itself. */}
										<span
											className="flex items-center justify-center rounded-md bg-transparent ring-1 ring-transparent transition-[background-color,box-shadow] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:bg-foreground/[0.04] group-data-[active]:bg-accent/[0.1] group-data-[active]:ring-accent/25"
											style={{ width: BADGE_SIZE, height: BADGE_SIZE }}
										>
											<HugeiconsIcon
												className="text-foreground-muted transition-colors duration-200 group-hover:text-foreground-secondary group-data-[active]:text-accent"
												icon={link.icon}
												size={16}
											/>
										</span>
									</span>
									<span
										className="pointer-events-none whitespace-nowrap pl-2 font-sans text-body text-foreground-secondary group-data-[active]:font-medium group-data-[active]:text-foreground"
										style={revealStyle(index + 1)}
									>
										{link.label}
									</span>
								</Tabs.Tab>
							);
							const row = link.tooltip ? (
								<Tooltip content={link.tooltip} side="right">
									{tab}
								</Tooltip>
							) : (
								tab
							);
							return (
								<div className="contents" key={link.key}>
									{row}
									{link.groupEnd ? (
										<div className="py-1">
											<RailSeparator />
										</div>
									) : null}
								</div>
							);
						})}
					</Tabs.List>
				</div>
			</div>
		</SurfaceProvider>
	);
}

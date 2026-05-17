"use client";

import { Tabs } from "@base-ui/react/tabs";
import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	SurfaceProvider,
	surfaceActiveBg,
	surfaceBg,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Tooltip } from "@/shared/ui/tooltip";

export interface SidebarLink {
	icon: IconSvgElement;
	key: string;
	label: string;
	/** Tooltip explaining what the tab configures */
	tooltip?: string;
}

interface SettingsSidebarProps {
	links: SidebarLink[];
	onReset?: () => void;
}

/**
 * Sidebar collapsed width is set in fixed px (52px via CSS).
 * Internal horizontal spacing must also use fixed px so icon centering
 * is independent of the root font-size (which is 14px, not 16px).
 *
 * SIDEBAR_PAD  = 8px each side → content = 52 − 16 = 36px
 * ICON_COL     = 36px          → fills content exactly, icon centered
 *
 * Width and label opacity transitions use CSS (will-change + GPU-composited
 * properties) instead of JS-driven framer-motion for better performance.
 */
export function SettingsSidebar({ links, onReset }: SettingsSidebarProps) {
	const [expanded, setExpanded] = useState(false);
	const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
	const t = useTranslations("settings");

	// Sidebar sits +1 above the page substrate; tabs hover +2 and active +3.
	// Children of the sidebar read the sidebar's level via SurfaceProvider.
	const substrate = useSurface();
	const railLevel = Math.min(substrate + 1, 8);
	const hoverLevel = Math.min(railLevel + 1, 8);
	const activeLevel = Math.min(railLevel + 2, 8);
	const activeBg = surfaceActiveBg(activeLevel);

	return (
		<SurfaceProvider value={railLevel}>
			{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: sidebar wrapper uses focus/hover events to drive visual expansion only */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: sidebar wrapper uses focus/hover events to drive visual expansion only */}
			<div
				className={`flex h-full shrink-0 flex-col overflow-hidden ${surfaceBg(railLevel)} shadow-[inset_-1px_0_0_0_var(--color-border)] transition-[width] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]`}
				onBlur={(e) => {
					if (!e.currentTarget.contains(e.relatedTarget)) {
						setExpanded(false);
					}
				}}
				onFocus={() => setExpanded(true)}
				onMouseEnter={() => setExpanded(true)}
				onMouseLeave={() => setExpanded(false)}
				style={{ width: expanded ? 170 : 52 }}
			>
				<Tabs.List className="relative flex flex-1 flex-col gap-1 px-[8px] py-3">
					{links.map((link) => {
						const tab = (
							<Tabs.Tab
								className={`group relative flex h-9 w-full cursor-pointer items-center rounded-md border-0 bg-transparent p-0 outline-none transition-colors duration-150 ${surfaceHoverBg(hoverLevel)} focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 ${activeBg}`}
								key={link.key}
								value={link.key}
							>
								<span className="flex items-center">
									<span className="flex w-[36px] shrink-0 items-center justify-center">
										<HugeiconsIcon
											className="text-foreground-muted transition-colors duration-150 group-data-[active]:text-teal"
											icon={link.icon}
											size={16}
										/>
									</span>
									<span
										className="whitespace-nowrap font-sans text-body text-foreground-secondary group-data-[active]:font-medium group-data-[active]:text-foreground"
										style={{
											opacity: expanded ? 1 : 0,
											display: expanded ? "inline" : "none",
											transition: expanded ? "opacity 150ms ease 50ms" : "opacity 150ms ease",
										}}
									>
										{link.label}
									</span>
								</span>
							</Tabs.Tab>
						);
						return link.tooltip ? (
							<Tooltip content={link.tooltip} key={link.key} side="right">
								{tab}
							</Tooltip>
						) : (
							tab
						);
					})}
					<Tabs.Indicator
						className="absolute left-0 z-raised w-[3px] rounded-r-sm bg-teal transition-all duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]"
						style={{
							top: 0,
							height: "calc(var(--active-tab-height) - 8px)",
							translate: "0 calc(var(--active-tab-top) + 4px)",
						}}
					/>
				</Tabs.List>
				{onReset && (
					<div className="px-[8px] py-2">
						<ConfirmDialog
							confirmLabel={t("resetConfirm")}
							description={t("resetDescription")}
							onConfirm={onReset}
							onOpenChange={setResetConfirmOpen}
							open={resetConfirmOpen}
							title={t("resetTitle")}
						/>
						<Tooltip content={t("resetDefaults")} side="right">
							<Button
								aria-label={t("resetDefaults")}
								className={`flex h-9 w-full items-center rounded-md bg-transparent p-0 transition-colors duration-150 ${surfaceHoverBg(hoverLevel)}`}
								onClick={() => setResetConfirmOpen(true)}
							>
								<span className="flex items-center">
									<span className="flex w-[36px] shrink-0 items-center justify-center">
										<HugeiconsIcon
											className="text-foreground-muted"
											icon={ArrowTurnBackwardIcon}
											size={16}
										/>
									</span>
									<span
										className="whitespace-nowrap font-sans text-body text-foreground-secondary"
										style={{
											opacity: expanded ? 1 : 0,
											display: expanded ? "inline" : "none",
											transition: expanded ? "opacity 150ms ease 50ms" : "opacity 150ms ease",
										}}
									>
										{t("resetDefaults")}
									</span>
								</span>
							</Button>
						</Tooltip>
					</div>
				)}
			</div>
		</SurfaceProvider>
	);
}

"use client";

import { Tabs } from "@base-ui/react/tabs";
import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

export interface SidebarLink {
	key: string;
	label: string;
	icon: IconSvgElement;
}

interface SettingsSidebarProps {
	links: SidebarLink[];
	onReset?: () => void;
}

/**
 * Sidebar collapsed width is set in fixed px (52px via framer-motion).
 * Internal horizontal spacing must also use fixed px so icon centering
 * is independent of the root font-size (which is 14px, not 16px).
 *
 * SIDEBAR_PAD  = 8px each side → content = 52 − 16 = 36px
 * ICON_COL     = 36px          → fills content exactly, icon centered
 */

export function SettingsSidebar({ links, onReset }: SettingsSidebarProps) {
	const [expanded, setExpanded] = useState(false);
	const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
	const shouldReduceMotion = useReducedMotion();
	const t = useTranslations("settings");

	return (
		<motion.div
			animate={{ width: expanded ? 170 : 52 }}
			className="flex h-full shrink-0 flex-col overflow-hidden bg-surface-primary shadow-[inset_-1px_0_0_0_var(--color-border)]"
			initial={false}
			onBlur={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget)) {
					setExpanded(false);
				}
			}}
			onFocus={() => setExpanded(true)}
			onMouseEnter={() => setExpanded(true)}
			onMouseLeave={() => setExpanded(false)}
			transition={{ duration: shouldReduceMotion ? 0 : 0.2, ease: [0.25, 0.1, 0.25, 1] }}
		>
			<Tabs.List className="relative flex flex-1 flex-col gap-1 px-[8px] py-3">
				{links.map((link) => (
					<Tabs.Tab
						className="group relative flex h-9 w-full cursor-pointer items-center rounded-md border-0 bg-transparent p-0 outline-none transition-colors duration-150 hover:bg-surface-tertiary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-primary data-[active]:bg-surface-elevated"
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
							<motion.span
								animate={{
									opacity: expanded ? 1 : 0,
									display: expanded ? "inline" : "none",
								}}
								className="whitespace-nowrap font-sans text-[13px] text-foreground-secondary group-data-[active]:font-medium group-data-[active]:text-foreground"
								transition={{ duration: shouldReduceMotion ? 0 : 0.15, delay: expanded ? 0.05 : 0 }}
							>
								{link.label}
							</motion.span>
						</span>
					</Tabs.Tab>
				))}
				<Tabs.Indicator
					className="absolute left-0 z-10 w-[3px] rounded-r-sm bg-teal transition-all duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]"
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
					<Button
						aria-label={t("resetDefaults")}
						className="flex h-9 w-full items-center rounded-md bg-transparent p-0 transition-colors duration-150 hover:bg-surface-tertiary"
						onClick={() => setResetConfirmOpen(true)}
						title={t("resetDefaults")}
					>
						<span className="flex items-center">
							<span className="flex w-[36px] shrink-0 items-center justify-center">
								<HugeiconsIcon
									className="text-foreground-muted"
									icon={ArrowTurnBackwardIcon}
									size={16}
								/>
							</span>
							<motion.span
								animate={{
									opacity: expanded ? 1 : 0,
									display: expanded ? "inline" : "none",
								}}
								className="whitespace-nowrap font-sans text-[13px] text-foreground-secondary"
								transition={{ duration: shouldReduceMotion ? 0 : 0.15, delay: expanded ? 0.05 : 0 }}
							>
								{t("resetDefaults")}
							</motion.span>
						</span>
					</Button>
				</div>
			)}
		</motion.div>
	);
}

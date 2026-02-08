"use client";

import { Tabs } from "@base-ui/react/tabs";
import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "framer-motion";
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

export function SettingsSidebar({ links, onReset }: SettingsSidebarProps) {
	const [expanded, setExpanded] = useState(false);
	const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

	return (
		<motion.div
			animate={{ width: expanded ? 170 : 52 }}
			className="flex h-full shrink-0 flex-col overflow-hidden border-border border-r bg-surface-primary"
			initial={false}
			onMouseEnter={() => setExpanded(true)}
			onMouseLeave={() => setExpanded(false)}
			transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
		>
			<Tabs.List className="relative flex flex-1 flex-col gap-1 p-3 px-2">
				{links.map((link) => (
					<Tabs.Tab
						className="group relative flex h-9 w-full cursor-pointer items-center rounded-md border-0 bg-transparent p-0 outline-none transition-colors duration-150 hover:bg-surface-tertiary data-[active]:bg-surface-elevated"
						key={link.key}
						value={link.key}
					>
						<span className="flex items-center">
							<span className="flex w-9 shrink-0 items-center justify-center">
								<HugeiconsIcon
									className="text-foreground-muted transition-colors duration-150 group-data-[active]:text-accent"
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
								transition={{ duration: 0.15, delay: expanded ? 0.05 : 0 }}
							>
								{link.label}
							</motion.span>
						</span>
					</Tabs.Tab>
				))}
				<Tabs.Indicator
					className="absolute left-0 z-10 w-[3px] rounded-r-sm bg-accent transition-all duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]"
					style={{
						top: 0,
						height: "calc(var(--active-tab-height) - 8px)",
						translate: "0 calc(var(--active-tab-top) + 4px)",
					}}
				/>
			</Tabs.List>
			{onReset && (
				<div className="p-2">
					<ConfirmDialog
						confirmLabel="Reset"
						description="All settings will be restored to their default values. This cannot be undone."
						onConfirm={onReset}
						onOpenChange={setResetConfirmOpen}
						open={resetConfirmOpen}
						title="Reset to Defaults?"
					/>
					<Button
						className="w-full justify-start rounded-md bg-transparent p-0 transition-colors duration-150 hover:bg-surface-tertiary"
						onClick={() => setResetConfirmOpen(true)}
						title="Reset to Defaults"
					>
						<span className="flex items-center">
							<span className="flex w-9 shrink-0 items-center justify-center">
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
								className="whitespace-nowrap font-sans text-foreground-secondary text-xs"
								transition={{ duration: 0.15, delay: expanded ? 0.05 : 0 }}
							>
								Reset Defaults
							</motion.span>
						</span>
					</Button>
				</div>
			)}
		</motion.div>
	);
}

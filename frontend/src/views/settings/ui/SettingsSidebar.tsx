import { Tabs } from "@base-ui/react/tabs";
import {
	Cancel01Icon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { Tooltip } from "@/shared/ui/tooltip";
import { matchesSearchQuery } from "../lib/settings-search";

/**
 * Hairline divider closing a logical tab group. Mirrors the rail's own edge
 * treatment: a `divider-strong` line lifted by a faint top-light highlight so
 * it reads as etched rather than a flat gray stroke.
 */
function RailSeparator() {
	return (
		<div
			aria-hidden="true"
			className="my-1.5 h-px w-full bg-[var(--color-divider-strong)] shadow-[0_1px_0_0_oklch(100%_0_0_/_0.05)]"
		/>
	);
}

export interface SidebarLink {
	/** Render a separator after this row to close a logical tab group */
	groupEnd?: boolean;
	icon: IconSvgElement;
	key: string;
	/**
	 * Section headings + key setting names this tab contains, fed into search so
	 * a query surfaces the tab by its contents (e.g. "display" → General). See
	 * `useSettingsSearchKeywords`.
	 */
	keywords?: string | undefined;
	label: string;
	/** Tooltip explaining what the tab configures — also fed into search */
	tooltip?: string;
}

interface SettingsSidebarProps {
	links: SidebarLink[];
	/** Close the settings window (rendered as the leading × in the header). */
	onClose: () => void;
}

const SIDEBAR_WIDTH = 170;
const COLLAPSED_WIDTH = 56;
const TAB_HEIGHT = 36;
const COLLAPSE_STORAGE_KEY = "winstt:settings-sidebar-collapsed";

// Persist the collapsed preference so it survives window reloads/reopens.
function readCollapsed(): boolean {
	try {
		return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}
function writeCollapsed(next: boolean): void {
	try {
		window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
	} catch {
		// no-op: a denied localStorage just means the preference won't persist
	}
}

/**
 * Settings sidebar — a column that shares the page substrate (surface-1) so it
 * reads as built into the window, with each tab's content floating a layer
 * above. Holds the close button, wordmark, a collapse toggle, a live search
 * filter, and the vertical tab list (hairline separators close logical groups).
 *
 * Collapsible: the toggle beside the wordmark shrinks the column to an
 * icon-only rail (search hidden, labels become hover tooltips) and back.
 */
export function SettingsSidebar({ links, onClose }: SettingsSidebarProps) {
	const t = useTranslations("settings");
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState(readCollapsed);

	// Sidebar stays at the page substrate; the search field lifts one step so it
	// reads as a recessed input against it.
	const substrate = useSurface();
	const inputLevel = Math.min(substrate + 1, 8);

	const toggleCollapsed = () => {
		setCollapsed((prev) => {
			const next = !prev;
			writeCollapsed(next);
			return next;
		});
	};

	const trimmed = query.trim().toLowerCase();
	const searching = trimmed.length > 0 && !collapsed;
	// Match against the tab's label, tooltip, AND its section/setting keywords
	// (so "display" surfaces General), with the dictionary's fuzzy matcher for
	// typo tolerance ("dispaly" → Display). See `matchesSearchQuery`.
	const visibleLinks = searching
		? links.filter((l) =>
				matchesSearchQuery(`${l.label} ${l.tooltip ?? ""} ${l.keywords ?? ""}`, trimmed)
			)
		: links;

	const closeButton = (
		<button
			aria-label={t("close")}
			className="titlebar-no-drag group flex size-7 shrink-0 items-center justify-center rounded-md bg-transparent text-foreground-muted outline-none transition-colors duration-150 hover:bg-error/85 hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
			onClick={onClose}
			type="button"
		>
			<HugeiconsIcon
				className="transition-transform duration-150 ease-out group-hover:scale-110"
				icon={Cancel01Icon}
				size={15}
			/>
		</button>
	);

	const toggleButton = (
		<Tooltip content={collapsed ? t("expandSidebar") : t("collapseSidebar")} side="right">
			<button
				aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
				className="titlebar-no-drag flex size-7 shrink-0 items-center justify-center rounded-md bg-transparent text-foreground-muted outline-none transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-accent"
				onClick={toggleCollapsed}
				type="button"
			>
				<HugeiconsIcon icon={collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon} size={16} />
			</button>
		</Tooltip>
	);

	return (
		<aside
			className="relative flex h-full shrink-0 flex-col bg-surface-1 transition-[width] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]"
			style={{ width: collapsed ? COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
		>
			{/* Header strip — close button + wordmark + collapse toggle. The h-14
			    band matches the content column's title band so "Settings" and the
			    active tab name sit on the same baseline. Draggable for window move. */}
			{collapsed ? (
				<div className="titlebar-drag flex flex-col items-center gap-1 px-2 pt-2.5 pb-1">
					{closeButton}
					{toggleButton}
				</div>
			) : (
				<div className="titlebar-drag flex h-14 shrink-0 items-center gap-2 px-3">
					{closeButton}
					<span className="font-semibold text-foreground text-title tracking-[-0.01em]">
						{t("title")}
					</span>
					<div className="flex-1" />
					{toggleButton}
				</div>
			)}

			{/* Search — expanded only */}
			{collapsed ? null : (
				<div className="titlebar-no-drag px-3 pb-3">
					<div className="relative flex items-center">
						<HugeiconsIcon
							aria-hidden="true"
							className="pointer-events-none absolute start-2.5 text-foreground-muted"
							icon={Search01Icon}
							size={14}
						/>
						<input
							aria-label={t("searchPlaceholder")}
							className={`h-8 w-full rounded-md ps-8 pe-7 text-body text-foreground caret-accent outline-none ring-1 ring-divider transition-shadow placeholder:text-foreground-muted hover:ring-border focus-visible:ring-2 focus-visible:ring-accent ${surfaceBg(inputLevel)}`}
							onChange={(e) => setQuery(e.target.value)}
							placeholder={t("searchPlaceholder")}
							type="text"
							value={query}
						/>
						{trimmed.length > 0 ? (
							<button
								aria-label={t("searchClear")}
								className="absolute end-1.5 flex size-5 items-center justify-center rounded-full bg-transparent text-foreground-muted outline-none transition-colors hover:bg-foreground/10 hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-accent"
								onClick={() => setQuery("")}
								type="button"
							>
								<HugeiconsIcon icon={Cancel01Icon} size={12} />
							</button>
						) : null}
					</div>
				</div>
			)}

			{/* Tab list */}
			<Tabs.List
				className={cn(
					"relative flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-3",
					collapsed ? "items-center px-2" : "px-2"
				)}
			>
				{visibleLinks.length === 0 ? (
					<p className="px-2.5 py-4 text-body-sm text-foreground-muted">{t("searchNoResults")}</p>
				) : (
					visibleLinks.map((link) => {
						const tab = (
							<Tabs.Tab
								className={cn(
									"group/seg relative flex cursor-pointer items-center rounded-md border-0 bg-transparent py-0 outline-none transition-[background-color,box-shadow] duration-150 hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 data-[active]:bg-accent/[0.08] data-[active]:shadow-[inset_0_0_0_1px_var(--color-divider-strong)]",
									collapsed ? "w-9 justify-center" : "w-full gap-2.5 ps-2.5 pe-2.5"
								)}
								style={{ height: TAB_HEIGHT }}
								value={link.key}
							>
								{/* Active-row accent bar at the leading edge */}
								<span
									aria-hidden="true"
									className="pointer-events-none absolute start-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent opacity-0 transition-opacity duration-150 group-data-[active]/seg:opacity-100"
								/>
								<HugeiconsIcon
									className="shrink-0 text-foreground-muted transition-colors duration-150 group-hover/seg:text-foreground-secondary group-data-[active]/seg:text-accent"
									icon={link.icon}
									size={17}
								/>
								{collapsed ? null : (
									<span className="min-w-0 flex-1 truncate text-start font-sans text-body text-foreground-secondary transition-colors duration-150 group-data-[active]/seg:font-medium group-data-[active]/seg:text-foreground">
										{link.label}
									</span>
								)}
							</Tabs.Tab>
						);
						return (
							<div className="contents" key={link.key}>
								{collapsed ? (
									<Tooltip content={link.label} side="right">
										{tab}
									</Tooltip>
								) : (
									tab
								)}
								{/* Group separators only when the list isn't filtered */}
								{!searching && link.groupEnd ? <RailSeparator /> : null}
							</div>
						);
					})
				)}
			</Tabs.List>
		</aside>
	);
}

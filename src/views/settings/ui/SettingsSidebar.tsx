import { Button as BaseButton } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import {
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m,
	useIsPresent,
	useReducedMotion,
} from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { ClearableTextField } from "@/shared/ui/text-field";
import { Tooltip } from "@/shared/ui/tooltip";
import { matchesSearchQuery } from "../lib/settings-search";

function RailSeparator() {
	return <div aria-hidden="true" className="settings-sidebar-separator" />;
}

export interface SidebarLink {
	groupEnd?: boolean;
	icon: IconSvgElement;
	key: string;
	keywords?: string | undefined;
	label: string;
	tooltip?: string;
}

interface SettingsSidebarProps {
	links: SidebarLink[];
}

const SIDEBAR_WIDTH = 200;
const COLLAPSED_WIDTH = 56;
const COLLAPSE_STORAGE_KEY = "winstt:settings-sidebar-collapsed";

function SearchResultRow({
	children,
	collapsed,
	reduceMotion,
}: {
	children: ReactNode;
	collapsed: boolean;
	reduceMotion: boolean;
}) {
	const isPresent = useIsPresent();
	return (
		<m.div
			animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
			aria-hidden={isPresent ? undefined : true}
			className={cn("flex flex-col", collapsed ? "w-[2.4rem]" : "w-full")}
			data-settings-search-result="true"
			exit={
				reduceMotion
					? { opacity: 1, transition: { duration: 0 } }
					: {
							opacity: 0,
							y: -4,
							filter: "blur(2px)",
							transition: { duration: 0.12 },
						}
			}
			initial={reduceMotion ? false : { opacity: 0, y: 4, filter: "blur(2px)" }}
			transition={
				reduceMotion
					? { duration: 0 }
					: { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
			}
		>
			{children}
		</m.div>
	);
}

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
	} catch {}
}

export function SettingsSidebar({ links }: SettingsSidebarProps) {
	const t = useTranslations("settings");
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const [searchOpen, setSearchOpen] = useState(false);
	const reduceMotion = useReducedMotion();
	const inputRef = useRef<HTMLInputElement>(null);
	const searchRegionRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!searchOpen) {
			return;
		}
		const onOutsidePress = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && searchRegionRef.current?.contains(target)) {
				return;
			}
			window.setTimeout(() => {
				setSearchOpen(false);
				setQuery("");
			}, 120);
		};
		document.addEventListener("pointerdown", onOutsidePress, true);
		return () =>
			document.removeEventListener("pointerdown", onOutsidePress, true);
	}, [searchOpen]);

	const closeSearch = () => {
		setSearchOpen(false);
		setQuery("");
		inputRef.current?.blur();
	};

	const handleSearchBlur = () => {
		window.setTimeout(() => {
			if (document.activeElement !== inputRef.current) {
				setSearchOpen(false);
				setQuery("");
			}
		}, 120);
	};

	const openSearch = () => {
		if (collapsed) {
			setCollapsed(false);
			writeCollapsed(false);
		}
		setSearchOpen(true);
	};

	const toggleCollapsed = () => {
		const next = !collapsed;
		setCollapsed(next);
		writeCollapsed(next);
		if (next) {
			closeSearch();
		}
	};

	const trimmed = query.trim().toLowerCase();
	const searching = trimmed.length > 0 && !collapsed;
	const visibleLinks = searching
		? links.filter((l) =>
				matchesSearchQuery(
					`${l.label} ${l.tooltip ?? ""} ${l.keywords ?? ""}`,
					trimmed,
				),
			)
		: links;

	const searchButton = (
		<BaseButton
			aria-label={t("searchPlaceholder")}
			className="settings-sidebar-icon-button titlebar-no-drag flex shrink-0 items-center justify-center bg-transparent text-foreground-muted outline-none transition-[background-color,color,transform,box-shadow] duration-200 hover:text-foreground-secondary active:translate-y-px focus-visible:ring-2 focus-visible:ring-accent"
			onClick={openSearch}
			type="button"
		>
			<HugeiconsIcon icon={Search01Icon} size={17} />
		</BaseButton>
	);

	const toggleButton = (
		<Tooltip
			content={collapsed ? t("expandSidebar") : t("collapseSidebar")}
			side="right"
		>
			<BaseButton
				aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
				className="settings-sidebar-icon-button titlebar-no-drag flex shrink-0 items-center justify-center bg-transparent text-foreground-muted outline-none transition-[background-color,color,transform,box-shadow] duration-200 hover:text-foreground-secondary active:translate-y-px focus-visible:ring-2 focus-visible:ring-accent"
				onClick={toggleCollapsed}
				type="button"
			>
				<HugeiconsIcon
					icon={collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon}
					size={17}
				/>
			</BaseButton>
		</Tooltip>
	);

	return (
		<aside
			className="settings-sidebar-shell relative flex h-full shrink-0 flex-col transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
			data-collapsed={collapsed ? "true" : undefined}
			style={{ width: collapsed ? COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
		>
			{collapsed ? (
				<div className="settings-sidebar-collapsed-header relative flex shrink-0 items-center justify-center px-2 pt-5 pb-4">
					<div
						aria-hidden="true"
						className="titlebar-drag absolute inset-x-0 top-0 h-4"
						data-slot="settings-sidebar-top-drag"
					/>
					{toggleButton}
				</div>
			) : (
				<div className="settings-sidebar-header relative flex h-[4.25rem] shrink-0 items-center gap-2 px-5 pt-4 pb-3">
					<div
						aria-hidden="true"
						className="titlebar-drag absolute inset-x-0 top-0 h-4"
						data-slot="settings-sidebar-top-drag"
					/>
					<div
						className="relative flex h-10 min-w-0 flex-1 items-center gap-2"
						ref={searchRegionRef}
					>
						{searchOpen ? null : searchButton}
						{searchOpen ? null : (
							<span className="titlebar-drag flex min-w-0 flex-1 items-center self-stretch">
								<span className="settings-sidebar-title min-w-0 flex-1 truncate font-semibold uppercase">
									{t("title")}
								</span>
							</span>
						)}
						<div
							aria-hidden={searchOpen ? undefined : true}
							className="t-resize titlebar-no-drag absolute inset-y-0 start-0 flex items-center overflow-hidden"
							style={{ width: searchOpen ? "100%" : "0px" }}
						>
							<ClearableTextField
								aria-label={t("searchPlaceholder")}
								autoFocus={searchOpen}
								clearLabel={t("searchClear")}
								className="settings-sidebar-search-input border shadow-none transition-colors focus-visible:ring-0 focus-visible:ring-offset-0"
								key={searchOpen ? "search-open" : "search-closed"}
								leadingIcon={
									<HugeiconsIcon
										aria-hidden="true"
										icon={Search01Icon}
										size={17}
									/>
								}
								onBlur={handleSearchBlur}
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										e.stopPropagation();
										closeSearch();
									}
								}}
								onValueChange={setQuery}
								placeholder={t("searchPlaceholderShort")}
								ref={inputRef}
								tabIndex={searchOpen ? 0 : -1}
								type="text"
								value={query}
								wrapperClassName="w-full"
							/>
						</div>
					</div>
					{toggleButton}
				</div>
			)}

			<Tabs.List
				className={cn(
					"settings-sidebar-list relative flex min-h-0 flex-1 flex-col overflow-y-auto",
					collapsed ? "items-center px-2 pt-1 pb-5" : "px-4 pt-3 pb-6",
				)}
			>
				<LazyMotion features={domAnimation} strict>
					<AnimatePresence initial={false} mode="sync">
						{visibleLinks.length === 0 ? (
							<m.p
								animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
								className="px-2.5 py-4 text-body-sm text-foreground-muted"
								exit={
									reduceMotion
										? { opacity: 1, transition: { duration: 0 } }
										: {
												opacity: 0,
												y: -4,
												filter: "blur(2px)",
												transition: { duration: 0.12 },
											}
								}
								initial={
									reduceMotion
										? false
										: { opacity: 0, y: 4, filter: "blur(2px)" }
								}
								key="settings-search-empty"
								transition={
									reduceMotion
										? { duration: 0 }
										: { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
								}
							>
								{t("searchNoResults")}
							</m.p>
						) : (
							visibleLinks.map((link) => {
								const tab = (
									<Tabs.Tab
										className={cn(
											"settings-sidebar-tab group/seg relative flex cursor-pointer items-center border-0 bg-transparent py-0 outline-none transition-[background-color,color,transform,box-shadow] duration-200 ease-out active:translate-y-px focus-visible:ring-2 focus-visible:ring-accent",
											collapsed
												? "settings-sidebar-tab-collapsed justify-center"
												: "w-full gap-2.5 ps-4 pe-4",
										)}
										value={link.key}
									>
										<HugeiconsIcon
											className="settings-sidebar-tab-icon shrink-0 text-foreground-muted transition-colors duration-200 group-hover/seg:text-foreground-secondary group-data-[active]/seg:text-foreground"
											icon={link.icon}
											size={17}
										/>
										{collapsed ? null : (
											<span className="settings-sidebar-tab-label min-w-0 flex-1 truncate text-start font-sans transition-colors duration-200 group-data-[active]/seg:text-foreground">
												{link.label}
											</span>
										)}
									</Tabs.Tab>
								);
								return (
									<SearchResultRow
										collapsed={collapsed}
										key={link.key}
										reduceMotion={reduceMotion ?? false}
									>
										{collapsed ? (
											<Tooltip content={link.label} side="right">
												{tab}
											</Tooltip>
										) : (
											tab
										)}
										{!searching && link.groupEnd ? <RailSeparator /> : null}
									</SearchResultRow>
								);
							})
						)}
					</AnimatePresence>
				</LazyMotion>
			</Tabs.List>
		</aside>
	);
}

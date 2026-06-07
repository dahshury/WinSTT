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
  return (
    <div
      aria-hidden="true"
      className="my-2 h-px w-full bg-[var(--color-divider)]"
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
}

const SIDEBAR_WIDTH = 200;
const COLLAPSED_WIDTH = 56;
const TAB_HEIGHT = 36;
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
      className={cn("flex flex-col", collapsed ? "w-9" : "w-full")}
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
 * above. Holds a search affordance (an icon that grows into a live filter
 * field), the wordmark, a collapse toggle, and the vertical tab list (hairline
 * separators close logical groups). The window close button lives in the
 * content card (top-right), not here.
 *
 * The search starts as an icon sitting where the close button used to (leading
 * edge of the header). Clicking it tweens a field open over the "Settings"
 * wordmark (width transition via `.t-resize`); the wordmark hides while it's
 * open. The field folds back when it loses focus — either a blur, or a pointer
 * press anywhere outside it (a plain click on a non-focusable region never
 * blurs an input, so the outside-press listener is what actually catches it).
 *
 * Collapsible: the toggle beside the wordmark shrinks the column to an
 * icon-only rail (labels become hover tooltips) and back.
 */
export function SettingsSidebar({ links }: SettingsSidebarProps) {
  const t = useTranslations("settings");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [searchOpen, setSearchOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  // Wraps the search affordance + field so an outside-press can tell whether
  // the press landed on the search or somewhere it should fold away.
  const searchRegionRef = useRef<HTMLDivElement>(null);

  // Focus the field the moment it opens so the user can type immediately.
  useEffect(() => {
    if (searchOpen) {
      inputRef.current?.focus();
    }
  }, [searchOpen]);

  // Fold the field away on any pointer press outside it. A click on a
  // non-focusable region (drag strip, a tab row, the content card) never
  // blurs the input, so `onBlur` alone misses it — this is the catch-all.
  // Deferred one tick so a press landing on a filtered tab selects it before
  // the list reverts to the full set.
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
    // Capture phase + pointerdown so the press is caught even when a child
    // (a Base UI tab, the scroll area, a field in the tab content) stops
    // propagation in the bubble phase — that was why some outside presses
    // didn't fold the field away.
    document.addEventListener("pointerdown", onOutsidePress, true);
    return () =>
      document.removeEventListener("pointerdown", onOutsidePress, true);
  }, [searchOpen]);

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  // Keyboard tab-away: focus leaves to a real focusable (toggle, a tab). A
  // click on a non-focusable region is handled by the outside-press listener
  // above instead. Deferred + guarded so refocus (e.g. the clear button) wins.
  const handleSearchBlur = () => {
    window.setTimeout(() => {
      if (document.activeElement !== inputRef.current) {
        setSearchOpen(false);
        setQuery("");
      }
    }, 120);
  };

  const openSearch = () => {
    // No room for the field in the collapsed rail — expand first.
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
    // Collapsing has no room for the search field — fold it away cleanly.
    if (next) {
      closeSearch();
    }
  };

  const trimmed = query.trim().toLowerCase();
  const searching = trimmed.length > 0 && !collapsed;
  // Match against the tab's label, tooltip, AND its section/setting keywords
  // (so "display" surfaces General), with the dictionary's fuzzy matcher for
  // typo tolerance ("dispaly" → Display). See `matchesSearchQuery`.
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
      className="titlebar-no-drag flex size-7 shrink-0 items-center justify-center rounded-md bg-transparent text-foreground-muted outline-none transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-accent"
      onClick={openSearch}
      type="button"
    >
      <HugeiconsIcon icon={Search01Icon} size={16} />
    </BaseButton>
  );

  const toggleButton = (
    <Tooltip
      content={collapsed ? t("expandSidebar") : t("collapseSidebar")}
      side="right"
    >
      <BaseButton
        aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
        className="titlebar-no-drag flex size-7 shrink-0 items-center justify-center rounded-md bg-transparent text-foreground-muted outline-none transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-accent"
        onClick={toggleCollapsed}
        type="button"
      >
        <HugeiconsIcon
          icon={collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon}
          size={16}
        />
      </BaseButton>
    </Tooltip>
  );

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col bg-surface-1 transition-[width] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]"
      style={{ width: collapsed ? COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
    >
      {/* Header strip — search affordance + wordmark + collapse toggle. The
			    h-12 band gives the column a compact title region. Draggable for window move;
			    opening search tweens a field over the wordmark. */}
      {collapsed ? (
        <div className="flex flex-col items-center gap-1 px-2 pb-1">
          {/* Dedicated window-move handle. It must be its OWN element, never a
					    wrapper around the buttons: an interactive control can't live inside
					    an `-webkit-app-region: drag` region because on touch devices the OS
					    caption path swallows the tap before the `no-drag` carve-out is
					    consulted, leaving the button unclickable by touch (Tauri #4746). A
					    short full-width strip keeps the rail draggable while the buttons
					    below sit on plain client pixels. */}
          <div
            aria-hidden="true"
            className="titlebar-drag h-3.5 w-full shrink-0"
            data-slot="settings-sidebar-top-drag"
          />
          {toggleButton}
        </div>
      ) : (
        // The header itself is NOT a drag region — only the wordmark below is
        // (see its note). Keeping the buttons off any `drag` region is what makes
        // them tappable on touch (Tauri #4746), and a neutral header also means a
        // press in the gutter while the field is open reaches the outside-press
        // listener that folds the field away.
        <div className="relative flex h-12 shrink-0 items-center gap-2 px-3">
          <div
            aria-hidden="true"
            className="titlebar-drag absolute inset-x-0 top-0 h-3.5"
            data-slot="settings-sidebar-top-drag"
          />
          <div
            className="relative flex h-full min-w-0 flex-1 items-center gap-2"
            ref={searchRegionRef}
          >
            {searchOpen ? null : (
              <>
                {searchButton}
                {/* The wordmark doubles as the window-move handle (`drag`). It
								    sits between the buttons, so they keep their own plain client
								    pixels and stay tappable on touch — see the collapsed-header
								    note and Tauri #4746. `self-stretch` makes the drag box fill the
								    FULL header height (not just the text line), so the strip ABOVE
								    and below the word is draggable too; the inner span keeps the
								    truncating text vertically centred. */}
                <span className="titlebar-drag flex min-w-0 flex-1 items-center self-stretch">
                  <span className="min-w-0 flex-1 truncate font-semibold text-2xs text-foreground-secondary uppercase tracking-[0.14em]">
                    {t("title")}
                  </span>
                </span>
              </>
            )}
            {/* Search field — an overlay that tweens its width 0 → full over the
						    region (the `.t-resize` recipe) so it grows in / out instead of
						    snapping. Always mounted so the close also animates; gated out of
						    the a11y/tab order while folded. */}
            <div
              className="t-resize titlebar-no-drag absolute inset-y-0 start-0 flex items-center overflow-hidden"
              style={{ width: searchOpen ? "100%" : "0px" }}
            >
              <ClearableTextField
                aria-hidden={!searchOpen}
                aria-label={t("searchPlaceholder")}
                clearLabel={t("searchClear")}
                className="h-8 rounded-md border border-border bg-surface-2 shadow-none transition-colors focus-visible:border-border-hover focus-visible:ring-0 focus-visible:ring-offset-0"
                leadingIcon={
                  <HugeiconsIcon
                    aria-hidden="true"
                    icon={Search01Icon}
                    size={14}
                  />
                }
                onBlur={handleSearchBlur}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    // Close the field, not the window.
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

      {/* Tab list */}
      <Tabs.List
        className={cn(
          "relative flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-3",
          collapsed ? "items-center px-2" : "px-2",
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
                      "group/seg relative flex cursor-pointer items-center rounded-md border-0 bg-transparent py-0 outline-none transition-[background-color,color,transform] duration-150 ease-out hover:bg-foreground/[0.04] active:translate-y-px focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 data-[active]:bg-foreground/[0.08] data-[active]:hover:bg-foreground/[0.09]",
                      collapsed
                        ? "w-9 justify-center"
                        : "w-full gap-2.5 ps-2.5 pe-2.5",
                    )}
                    style={{ height: TAB_HEIGHT }}
                    value={link.key}
                  >
                    <HugeiconsIcon
                      className="shrink-0 text-foreground-muted transition-colors duration-150 group-hover/seg:text-foreground-secondary group-data-[active]/seg:text-foreground"
                      icon={link.icon}
                      size={17}
                    />
                    {collapsed ? null : (
                      <span className="min-w-0 flex-1 truncate text-start font-sans font-medium text-body text-foreground-secondary transition-colors duration-150 group-data-[active]/seg:text-foreground">
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
                    {/* Group separators only when the list isn't filtered */}
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

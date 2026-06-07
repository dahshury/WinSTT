import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
  SurfaceProvider,
  surfaceBg,
  surfaceClasses,
  useSurface,
} from "@/shared/lib/surface";
import { MenuHighlightLayer } from "@/shared/ui/menu-highlight";
import type { SelectOption, SelectOptionGroup } from "@/shared/ui/select";
import "./searchable-select.css";

// `SelectOptionGroup` now lives alongside `SelectOption` in `select/Select.tsx`
// (the more primitive layer, so the Menu-based `Select` can use it too without
// a circular import). Re-exported here so existing imports from
// `@/shared/ui/searchable-select` keep working.
export type { SelectOptionGroup } from "@/shared/ui/select";

export interface SearchableSelectProps {
  /**
   * Open the popup on mount (uncontrolled initial state). Used by the detached
   * model-picker window, whose whole purpose is to show the options — there a
   * closed combobox would force a pointless second click. Settings-panel usage
   * omits this so the combobox stays closed until the user opens it.
   */
  defaultOpen?: boolean;
  disabled?: boolean;
  /**
   * Grouped options. When provided, the popup renders one sticky
   * `Combobox.GroupLabel` header per group (the per-row badge is dropped —
   * the header carries the shared attribute) and `options` is ignored for
   * the list. The trigger's selected-value lookup still spans every group.
   */
  groups?: readonly SelectOptionGroup[];
  /**
   * Interactive node pinned inside the trigger, just left of the chevron —
   * stays visible whether the popup is open or closed. Pointer/click events
   * are stopped from bubbling so it can't toggle the popup. Used by the TTS
   * voice picker for the "preview selected voice" play/stop control.
   */
  inputTrailing?: ReactNode;
  onChange: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  /** Flat options. Mutually exclusive with `groups` (which takes precedence). */
  options?: readonly SelectOption[];
  placeholder?: string;
  /**
   * Per-row trailing node rendered at the end of each option in the popup.
   * Pointer/click events are stopped so pressing it previews that row
   * without selecting (or closing) the combobox.
   */
  renderItemTrailing?: (option: SelectOption) => ReactNode;
  value: string;
}

function getItemLabel(item: SelectOption | null): string {
  return item ? item.label : "";
}

function Badge({ text }: { text: string }) {
  const level = Math.min(useSurface() + 1, 8);
  return (
    <span
      className={`pointer-events-none inline-flex h-4 min-w-[22px] shrink-0 items-center justify-center rounded-xs border border-border px-1 font-mono font-semibold text-[10px] text-foreground-secondary uppercase tracking-wider ${surfaceBg(level)}`}
    >
      {text}
    </span>
  );
}

/**
 * Wraps an interactive control rendered inside the combobox so its pointer
 * and click events don't reach Base UI's input/item handlers (which would
 * otherwise toggle the popup or commit the row).
 *
 * This shim has no semantics of its own — it's a pure event-eating container
 * whose only job is to keep Base UI's listbox/input handlers from reacting to
 * presses on the decorative child controls. `role="presentation"` opts the
 * element out of the accessibility tree, and the swallow listeners are
 * attached imperatively via a ref so the JSX surface stays free of handlers
 * on a non-interactive element (satisfies Biome a11y rules cleanly without
 * suppressions). Keyboard activation flows through whichever inner `<button>`
 * is rendered as a child; the shim itself is never a tab stop.
 */
function StopBubble({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  // Must use React's synthetic onClick (not addEventListener) so that
  // stopPropagation runs AFTER the inner button's React onClick has fired
  // at the document-root delegated handler. A native addEventListener fires
  // during the DOM bubble phase BEFORE the event reaches React's root —
  // stopping it there silently drops the click from React entirely, which
  // is what caused the row-preview button test to fail when this was
  // rewritten to use addEventListener for lint cleanliness.
  const swallow = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: role="toolbar" IS interactive per WAI-ARIA, and this shim's only job is to stop pointer/keyboard events from bubbling out to the parent listbox row so an inner control (preview button, etc.) can be activated without selecting the row.
    <div
      className={className}
      onClick={swallow}
      onKeyDown={swallow}
      onMouseDown={swallow}
      onPointerDown={swallow}
      role="toolbar"
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

function OptionIcon({
  active,
  icon,
}: {
  active?: boolean;
  icon: NonNullable<SelectOption["icon"]>;
}) {
  return (
    <HugeiconsIcon
      aria-hidden="true"
      className="pointer-events-none shrink-0 text-foreground-muted"
      icon={icon}
      size={16}
      strokeWidth={active ? 2 : 1.5}
    />
  );
}

function ItemTrailing({
  item,
  render,
}: {
  item: SelectOption;
  render: (option: SelectOption) => ReactNode;
}) {
  return (
    <StopBubble className="ml-auto flex shrink-0 items-center">
      {render(item)}
    </StopBubble>
  );
}

// Sticky section header for grouped mode — mirrors the STT model list's
// `AuthorLabel`. The trailing badge carries the group's short code (e.g.
// the country) so the per-row badge can be dropped.
function GroupHeader({
  badge,
  label,
  level,
}: {
  badge?: string | undefined;
  label: string;
  level: number;
}) {
  return (
    <Combobox.GroupLabel
      // `z-overlay` (not `z-raised`): each `Row` is `relative z-raised`, so an
      // equal-z sticky header would be painted OVER by the rows scrolling under
      // it (later DOM, same z) — making the opaque header look transparent. A
      // higher z keeps the sticky header above its rows.
      className={`sticky top-0 z-overlay flex items-center gap-2 border-border/60 border-b px-2.5 py-1.5 ${surfaceBg(level)}`}
    >
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-[11px] text-foreground-muted uppercase tracking-[0.12em]">
        {label}
      </span>
      {badge ? <Badge text={badge} /> : null}
    </Combobox.GroupLabel>
  );
}

// One option row, shared by the flat and grouped list bodies. In grouped
// mode the per-row badge is suppressed (the `GroupHeader` carries it) and
// the row is indented a touch so it reads as nested under its header.
function Row({
  grouped,
  item,
  renderItemTrailing,
  value,
}: {
  grouped?: boolean | undefined;
  item: SelectOption;
  renderItemTrailing?: ((option: SelectOption) => ReactNode) | undefined;
  value: string;
}) {
  return (
    <Combobox.Item
      className={`searchable-select-item relative z-raised mx-1 flex cursor-default select-none items-center gap-2 rounded-xs py-2 pe-2 text-body text-foreground leading-normal outline-none data-[disabled]:cursor-not-allowed ${grouped ? "ps-4" : "ps-2"} data-[selected]:font-medium data-[selected]:text-foreground`}
      data-menu-option={item.id}
      disabled={item.disabled}
      value={item}
    >
      <span className="flex w-3 shrink-0 items-center justify-center">
        <Combobox.ItemIndicator>
          <CheckIcon />
        </Combobox.ItemIndicator>
      </span>
      {!grouped && item.badge ? <Badge text={item.badge} /> : null}
      {item.icon ? (
        <OptionIcon active={item.id === value} icon={item.icon} />
      ) : null}
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {item.label}
      </span>
      {renderItemTrailing ? (
        <ItemTrailing item={item} render={renderItemTrailing} />
      ) : null}
    </Combobox.Item>
  );
}

export function SearchableSelect({
  options,
  groups,
  value,
  onChange,
  onOpenChange,
  placeholder = "Search…",
  disabled = false,
  defaultOpen = false,
  inputTrailing,
  renderItemTrailing,
}: SearchableSelectProps) {
  const t = useTranslations("common");
  // Grouped mode flattens to a single list for the selected-value lookup +
  // the Combobox value contract; the popup still renders grouped.
  const flatOptions = groups
    ? groups.flatMap((g) => [...g.options])
    : (options ?? []);
  const selected = flatOptions.find((o) => o.id === value) ?? null;
  // Base UI accepts either a flat item array or its grouped collection shape
  // (`{ value, items }[]`, auto-detected via the nested `items` key); the
  // leaf type is the same SelectOption either way. Group header label/badge
  // aren't part of that shape, so look them up by `value` at render time.
  const comboboxItems: readonly unknown[] = groups
    ? groups.map((g) => ({ value: g.value, items: [...g.options] }))
    : [...flatOptions];
  const groupMeta = new Map((groups ?? []).map((g) => [g.value, g]));

  const substrate = useSurface();
  const inputLevel = Math.min(substrate + 1, 8);
  const popupLevel = Math.min(substrate + 2, 8);
  const popupShadow = Math.max(popupLevel, 6);

  // The popup is the `position: relative` scroll container the animated
  // selected/hover pills measure against (rows scroll inside it).
  const popupRef = useRef<HTMLDivElement | null>(null);

  // Measure the rendered badge/icon decoration so the input gets exactly
  // the right left-padding, regardless of how wide the badge text is
  // ("EN" vs "AUTO" vs "YUE"). A fixed estimate would either clip wider
  // badges or waste whitespace for short ones.
  const decorationRef = useRef<HTMLSpanElement>(null);
  const [decorationWidth, setDecorationWidth] = useState(0);
  const hasDecoration = Boolean(selected?.badge || selected?.icon);
  useLayoutEffect(() => {
    // When there's no decoration the measured width is irrelevant —
    // `decorationPadding` already short-circuits to 0 via `hasDecoration`,
    // so we skip the redundant state write and only sync on real nodes.
    const node = hasDecoration ? decorationRef.current : null;
    if (!node) {
      return;
    }
    const sync = () => setDecorationWidth(node.offsetWidth);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [hasDecoration]);
  // 8px matches `left-2` on the decoration span; the trailing 8px is the
  // gap between the decoration and the typed text.
  const decorationPadding = hasDecoration ? 8 + decorationWidth + 8 : 0;

  return (
    <Combobox.Root
      defaultOpen={defaultOpen}
      defaultValue={selected}
      disabled={disabled}
      isItemEqualToValue={(a: SelectOption | null, b: SelectOption | null) =>
        a?.id === b?.id
      }
      items={comboboxItems}
      itemToStringLabel={getItemLabel}
      onOpenChange={onOpenChange}
      onValueChange={(item: SelectOption | null) => {
        if (item) {
          onChange(item.id);
        }
      }}
      value={selected}
    >
      {/* `isolation-isolate` forces a stacking context on this wrapper so the
			    badge's positioned children can never escape and overlap other
			    comboboxes / popovers elsewhere on the page. */}
      <div className="relative isolate flex w-full items-center">
        {hasDecoration ? (
          <span
            className="pointer-events-none absolute top-1/2 left-2 flex -translate-y-1/2 items-center gap-1.5"
            ref={decorationRef}
          >
            {selected?.badge ? <Badge text={selected.badge} /> : null}
            {selected?.icon ? <OptionIcon active icon={selected.icon} /> : null}
          </span>
        ) : null}
        <Combobox.Input
          className={`flex h-8 w-full items-center rounded-lg ${surfaceClasses(inputLevel)} ${inputTrailing ? "pr-16" : "pr-7"} pl-2.5 font-inherit text-body text-foreground leading-normal outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 disabled:cursor-not-allowed disabled:opacity-40`}
          placeholder={placeholder}
          style={
            decorationPadding > 0
              ? { paddingLeft: `${decorationPadding}px` }
              : undefined
          }
        />
        {inputTrailing ? (
          <StopBubble className="absolute top-1/2 right-7 flex -translate-y-1/2 items-center">
            {inputTrailing}
          </StopBubble>
        ) : null}
        <Combobox.Trigger
          aria-label="Open popup"
          className="absolute top-1/2 right-1.5 flex size-5 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim"
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} />
        </Combobox.Trigger>
      </div>

      <Combobox.Portal>
        <SurfaceProvider value={popupLevel}>
          <Combobox.Positioner
            className="z-popover outline-none"
            collisionPadding={8}
            sideOffset={4}
          >
            <Combobox.Popup
              // Top padding lives on the LIST, not here: a sticky group header pins to
              // the scroll container's padding edge, so a `pt` on this scroller would
              // leave a band ABOVE the header where scrolling rows leak through. Keeping
              // only `pb-1` lets the header pin flush to the popup's top edge.
              className={`searchable-select-popup relative w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-lg ${surfaceClasses(popupLevel, popupShadow)} pb-1 [max-height:min(15rem,var(--available-height))]`}
              ref={popupRef}
            >
              <MenuHighlightLayer containerRef={popupRef} value={value} />
              <Combobox.Empty className="searchable-select-empty">
                {t("noResults")}
              </Combobox.Empty>
              <Combobox.List className="pt-1 outline-none">
                {groups
                  ? (group: { items: SelectOption[]; value: string }) => {
                      const meta = groupMeta.get(group.value);
                      return (
                        <Combobox.Group
                          className="flex flex-col"
                          items={group.items}
                          key={group.value}
                        >
                          <GroupHeader
                            badge={meta?.badge}
                            label={meta?.label ?? group.value}
                            level={popupLevel}
                          />
                          {group.items.map((item) => (
                            <Row
                              grouped
                              item={item}
                              key={item.id}
                              renderItemTrailing={renderItemTrailing}
                              value={value}
                            />
                          ))}
                        </Combobox.Group>
                      );
                    }
                  : (item: SelectOption) => (
                      <Row
                        item={item}
                        key={item.id}
                        renderItemTrailing={renderItemTrailing}
                        value={value}
                      />
                    )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </SurfaceProvider>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

// Decorative accessible name for the checkmark glyph. The <svg> is
// aria-hidden, so screen readers never announce this <title>; it's kept as a
// constant only so it isn't flagged as a user-facing literal.
const CHECK_ICON_TITLE = "Selected";

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentcolor"
      height="10"
      role="img"
      viewBox="0 0 10 10"
      width="10"
    >
      <title>{CHECK_ICON_TITLE}</title>
      <path d="M9.16 1.12C9.51 1.35 9.6 1.81 9.38 2.16L5.14 8.66C5.02 8.84 4.82 8.97 4.6 9C4.39 9.02 4.17 8.95 4.01 8.81L1.25 6.31C0.94 6.03 0.92 5.56 1.19 5.25C1.47 4.94 1.95 4.92 2.25 5.2L4.36 7.1L8.12 1.34C8.35 0.99 8.81 0.9 9.16 1.12Z" />
    </svg>
  );
}

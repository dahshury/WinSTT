import { Combobox } from "@base-ui/react/combobox";
import { Input } from "@base-ui/react/input";
import {
  ArrowDown01Icon,
  Cancel01Icon,
  Delete02Icon,
  PencilEdit01Icon,
  PlusSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  SurfaceProvider,
  surfaceBg,
  surfaceClasses,
  surfaceHighlightedBg,
  surfaceHoverBg,
  useSurface,
} from "@/shared/lib/surface";
import { IconButton } from "@/shared/ui/icon-button";
import "./editable-list-combobox.css";

/**
 * A combobox that *manages a set of strings* (search · add · edit · delete)
 * instead of selecting one value. Visually it mirrors the playground preset
 * combobox (`CreatableCombobox`): a single field that shows a count summary
 * when closed, and a dropdown that filters as you type with a synthesized
 * "create" row.
 *
 * Why this isn't built on `Combobox`'s selection: a deny-list is a *multi-
 * active set* with no "selected" item, and every row needs two interactive
 * controls (edit + delete) plus an in-place edit field. Base UI's single-
 * select Combobox force-closes the popup on item press and keeps real focus
 * on the trigger input (items are virtual, via `aria-activedescendant`), which
 * fights both requirements. So we use the Combobox purely as *chrome* — the
 * trigger input, the positioner, the popup, the open/close + dismiss lifecycle
 * and the entry/exit animation — and render fully custom rows inside the popup:
 *
 *  - Entry rows are plain elements (NOT `Combobox.Item`), so clicking them
 *    never selects-and-closes. Their edit/delete buttons act directly.
 *  - The only navigable `Combobox.Item` is the synthesized "create" row, so
 *    pressing Enter on a fresh candidate commits the add (and then closes, the
 *    same as the playground).
 *  - The inline editor is a plain input modeled on `SoundLibraryRow` — a
 *    callback ref focuses + selects on mount, Enter / ✓ commit, Esc / ✕ cancel.
 *    It lives inside the popup, so focusing it neither dismisses the popup
 *    (clicks inside the floating element aren't outside-presses) nor closes it
 *    on the trigger's blur (the trigger's `onBlur` only updates state).
 *
 * Add / edit / delete are derived from `value` + `onChange` here, so callers
 * just pass the list and a setter (same shape as the old `TagInput`). Entries
 * are normalised and de-duplicated, so re-adding or editing into an existing
 * value merges rather than duplicating.
 */
interface EditableListComboboxProps {
  /** aria-label for the inline editor's cancel (✕) button. */
  cancelAriaLabel: string;
  /** Wrapper width/placement classes (defaults to full width). */
  className?: string;
  /** Label for the synthesized "create" row, e.g. `Add "<candidate>"`. */
  createLabel: (candidate: string) => ReactNode;
  disabled?: boolean;
  /** aria-label for a row's edit (✎) button. */
  editAriaLabel: (entry: string) => string;
  /** Shown in the open popup when the list is empty. */
  emptyLabel: string;
  /** Accessible name for the search/add field and the chevron trigger. */
  inputAriaLabel?: string;
  /**
   * Canonical form a raw string is stored as — also what duplicate detection
   * compares against. Defaults to a plain trim.
   */
  normalize?: (raw: string) => string;
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** aria-label for a row's delete (🗑) button. */
  removeAriaLabel: (entry: string) => string;
  /** aria-label for the inline editor's save (✓) button. */
  saveAriaLabel: string;
  /** Closed-field text; receives the entry count (always ≥ 1 when shown). */
  summaryLabel: (count: number) => string;
  value: readonly string[];
}

const trimNormalize = (raw: string): string => raw.trim();
const identityLabel = (item: string): string => item;

export function EditableListCombobox({
  cancelAriaLabel,
  className,
  createLabel,
  disabled = false,
  editAriaLabel,
  emptyLabel,
  inputAriaLabel,
  normalize = trimNormalize,
  onChange,
  placeholder,
  removeAriaLabel,
  saveAriaLabel,
  summaryLabel,
  value,
}: EditableListComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The entry string being edited (null = none). Keyed by value, not index,
  // so an edit/delete elsewhere can't retarget the open editor.
  const [editing, setEditing] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const visibleEntries = needle
    ? value.filter((entry) => entry.toLowerCase().includes(needle))
    : [...value];
  const candidate = normalize(query);
  const canCreate = candidate.length > 0 && !value.includes(candidate);
  const items = canCreate ? [candidate] : [];

  // Closed field shows the count summary (or nothing → placeholder when
  // empty); open field shows the live search query. Mirrors CreatableCombobox
  // so the summary never pollutes the query: opening flips to `query` ("").
  const closedDisplay = value.length > 0 ? summaryLabel(value.length) : "";

  const addEntry = (raw: string): void => {
    const next = normalize(raw);
    if (!next || value.includes(next)) {
      return;
    }
    onChange([...value, next]);
    setQuery("");
  };

  const removeEntry = (entry: string): void => {
    onChange(value.filter((v) => v !== entry));
    if (editing === entry) {
      setEditing(null);
    }
  };

  const replaceEntry = (oldEntry: string, raw: string): void => {
    setEditing(null);
    const next = normalize(raw);
    // Empty edit cancels (no delete-on-empty surprise); unchanged is a no-op.
    if (!next || next === oldEntry) {
      return;
    }
    // Editing into an existing entry merges: drop the old one rather than
    // creating a duplicate.
    if (value.includes(next)) {
      onChange(value.filter((v) => v !== oldEntry));
      return;
    }
    onChange(value.map((v) => (v === oldEntry ? next : v)));
  };

  const substrate = useSurface();
  const inputLevel = Math.min(substrate + 1, 8);
  const popupLevel = Math.min(substrate + 2, 8);
  const popupShadow = Math.max(popupLevel, 6);
  const highlightLevel = Math.min(popupLevel + 1, 8);

  return (
    <div className={className ?? "w-full"}>
      <Combobox.Root
        autoHighlight
        disabled={disabled}
        filter={null}
        inputValue={open ? query : closedDisplay}
        items={items}
        itemToStringLabel={identityLabel}
        onInputValueChange={setQuery}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery("");
            setEditing(null);
          }
        }}
        onValueChange={(next) => {
          if (next) {
            addEntry(next);
          }
        }}
        open={open}
        value={null}
      >
        <div className="relative flex w-full items-center">
          <Combobox.Input
            aria-label={inputAriaLabel}
            className={`h-8 w-full rounded-lg ${surfaceClasses(inputLevel)} ps-2.5 pe-7 font-inherit text-body text-foreground leading-normal outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
            placeholder={placeholder}
          />
          <Combobox.Trigger
            aria-label={inputAriaLabel}
            className="absolute end-1.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim"
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
                className={`editable-list-combobox-popup w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-lg ${surfaceClasses(popupLevel, popupShadow)} py-1 [max-height:min(16rem,var(--available-height))]`}
              >
                {visibleEntries.length === 0 && !canCreate ? (
                  <div className="px-2.5 py-2 text-body-sm text-foreground-muted">
                    {emptyLabel}
                  </div>
                ) : null}

                {visibleEntries.map((entry) =>
                  editing === entry ? (
                    <EntryEditor
                      cancelAriaLabel={cancelAriaLabel}
                      initial={entry}
                      inputAriaLabel={inputAriaLabel}
                      key={entry}
                      onCancel={() => setEditing(null)}
                      onCommit={(raw) => replaceEntry(entry, raw)}
                      saveAriaLabel={saveAriaLabel}
                    />
                  ) : (
                    <EntryRow
                      editAriaLabel={editAriaLabel(entry)}
                      entry={entry}
                      key={entry}
                      onEdit={() => setEditing(entry)}
                      onRemove={() => removeEntry(entry)}
                      removeAriaLabel={removeAriaLabel(entry)}
                    />
                  ),
                )}

                <Combobox.List className="outline-none">
                  {(item: string) => (
                    <Combobox.Item
                      className={`mx-1 flex cursor-default select-none items-center gap-1.5 rounded-xs px-2.5 py-[7px] text-body text-foreground leading-normal outline-none ${surfaceHighlightedBg(highlightLevel)}`}
                      key={item}
                      value={item}
                    >
                      <HugeiconsIcon
                        aria-hidden="true"
                        className="shrink-0 text-accent"
                        icon={PlusSignIcon}
                        size={14}
                      />
                      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        {createLabel(item)}
                      </span>
                    </Combobox.Item>
                  )}
                </Combobox.List>
              </Combobox.Popup>
            </Combobox.Positioner>
          </SurfaceProvider>
        </Combobox.Portal>
      </Combobox.Root>
    </div>
  );
}

function EntryRow({
  editAriaLabel,
  entry,
  onEdit,
  onRemove,
  removeAriaLabel,
}: {
  editAriaLabel: string;
  entry: string;
  onEdit: () => void;
  onRemove: () => void;
  removeAriaLabel: string;
}) {
  const level = useSurface();
  const hoverLevel = Math.min(level + 1, 8);
  return (
    <div
      className={`mx-1 flex min-h-8 items-center gap-1.5 rounded-xs py-0.5 ps-2.5 pe-1 ${surfaceHoverBg(hoverLevel)}`}
    >
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] text-foreground leading-none">
        {entry}
      </span>
      <StopBubble>
        <IconButton
          aria-label={editAriaLabel}
          className="size-7"
          icon={<HugeiconsIcon icon={PencilEdit01Icon} size={14} />}
          onClick={onEdit}
        />
        <IconButton
          aria-label={removeAriaLabel}
          className="size-7 hover:bg-error-dim hover:text-error"
          icon={<HugeiconsIcon icon={Delete02Icon} size={14} />}
          onClick={onRemove}
        />
      </StopBubble>
    </div>
  );
}

/**
 * In-place editor. Mounted only while editing, so `draft` is genuine fresh
 * local state seeded at edit-start. The callback ref focuses + selects on
 * mount. There is intentionally NO commit-on-blur: with explicit ✓/✕ buttons,
 * blur-commit would race a ✕ click (the click blurs the input first). Edit ends
 * only on Enter/✓ (commit), Esc/✕ (cancel), or the popup closing.
 */
function EntryEditor({
  cancelAriaLabel,
  initial,
  inputAriaLabel,
  onCancel,
  onCommit,
  saveAriaLabel,
}: {
  cancelAriaLabel: string;
  initial: string;
  inputAriaLabel?: string | undefined;
  onCancel: () => void;
  onCommit: (next: string) => void;
  saveAriaLabel: string;
}) {
  const [draft, setDraft] = useState(() => initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const level = useSurface();
  const inputLevel = Math.min(level + 1, 8);

  // Focus + select-all once on mount (the editor is mounted fresh per edit).
  // A mount-only effect — NOT an inline callback ref, which React re-invokes
  // on every render and would re-select the text after each keystroke.
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const handleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Stop the bubble so Base UI's Escape-to-dismiss / Enter handling on the
    // combobox never sees the editor's own keys.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      onCommit(draft);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="mx-1 flex min-h-8 items-center gap-1.5 rounded-xs py-0.5 ps-2.5 pe-1">
      <Input
        aria-label={inputAriaLabel}
        className={`h-6 min-w-0 flex-1 rounded-xs ${surfaceBg(inputLevel)} px-1.5 font-mono text-[12px] text-foreground caret-accent leading-none outline-none ring-1 ring-accent placeholder:text-foreground-muted`}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKey}
        ref={inputRef}
        value={draft}
      />
      <StopBubble>
        <IconButton
          aria-label={saveAriaLabel}
          className="size-7 hover:bg-accent-dim hover:text-accent"
          icon={<HugeiconsIcon icon={Tick02Icon} size={14} />}
          onClick={() => onCommit(draft)}
        />
        <IconButton
          aria-label={cancelAriaLabel}
          className="size-7"
          icon={<HugeiconsIcon icon={Cancel01Icon} size={14} />}
          onClick={onCancel}
        />
      </StopBubble>
    </div>
  );
}

/** Eats pointer/keyboard events so a row's inline buttons don't bubble up to
 *  the combobox (dismiss / re-focus). Mirrors CreatableCombobox / SearchableSelect. */
function StopBubble({ children }: { children: ReactNode }) {
  const swallow = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: role="toolbar" is interactive per WAI-ARIA; this shim only stops events from bubbling to the combobox so the inner buttons can fire without dismissing/refocusing it.
    <div
      className="flex shrink-0 items-center gap-0.5"
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

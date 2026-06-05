"use client";

import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { extractCloseReason } from "./combobox-reasons";
import { useModelSelectorClickTracking } from "./use-model-selector-click-tracking";

const POPUP_ROLES: ReadonlySet<string> = new Set([
  "menu",
  "menuitem",
  "tooltip",
  // AlertDialog popups portaled out of the combobox (e.g. delete confirmations).
  "alertdialog",
]);

/**
 * Union of every picker's filter-menu Popover.Popup ``data-slot`` value.
 * Extend this when a picker adds another portaled menu that should not close
 * the owning combobox on first click.
 */
export type FilterMenuPopupSlot =
  | "model-filters-menu-content"
  | "ollama-sort-menu-content"
  | "stt-filters-menu-content";

const POPUP_SLOTS: ReadonlySet<FilterMenuPopupSlot> =
  new Set<FilterMenuPopupSlot>([
    "model-filters-menu-content",
    "ollama-sort-menu-content",
    "stt-filters-menu-content",
  ]);

export function nodeRoleIsPopup(node: HTMLElement): boolean {
  const role = node.getAttribute("role");
  return role !== null && POPUP_ROLES.has(role);
}

export function nodeSlotIsPopup(node: HTMLElement): boolean {
  const slot = node.dataset?.slot;
  return slot !== undefined && (POPUP_SLOTS as ReadonlySet<string>).has(slot);
}

export function nodeMatchesPopupSelector(
  node: HTMLElement,
  ownPopup: HTMLElement | null,
): boolean {
  return node === ownPopup || nodeRoleIsPopup(node) || nodeSlotIsPopup(node);
}

export function walkAncestors(start: HTMLElement | null): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (let cursor = start; cursor; cursor = cursor.parentElement) {
    chain.push(cursor);
  }
  return chain;
}

export function isInsideMenuPopup(
  target: HTMLElement | null,
  ownPopup: HTMLElement | null,
): boolean {
  return walkAncestors(target).some((node) =>
    nodeMatchesPopupSelector(node, ownPopup),
  );
}

export function shouldInterceptClose(
  reason: string | undefined,
  itemPressReason: string,
  isInsidePopup: boolean,
): boolean {
  return reason !== itemPressReason && isInsidePopup;
}

export function applyCloseWith(
  reason: string | undefined,
  itemPressReason: string,
  isInsidePopup: boolean,
  setOpen: (open: boolean) => void,
): boolean {
  if (shouldInterceptClose(reason, itemPressReason, isInsidePopup)) {
    return false;
  }
  setOpen(false);
  return true;
}

export interface UseModelPickerCloseGuardOptions {
  itemPressReason?: string;
  onOpen?: (() => void) | undefined;
  setOpen: (open: boolean) => void;
}

export interface ModelPickerCloseGuard {
  handleOpenChange: (next: boolean, eventDetails?: unknown) => void;
  popupRef: RefObject<HTMLElement | null>;
  setPopupNode: (node: HTMLElement | null) => void;
}

/**
 * Shared controlled-open guard for model pickers with portaled filter/sort
 * popups. It opens normally, but vetoes close attempts caused by clicks inside
 * friendly sibling popups while still allowing real item selections to close.
 */
export function useModelPickerCloseGuard({
  itemPressReason = "item-press",
  onOpen,
  setOpen,
}: UseModelPickerCloseGuardOptions): ModelPickerCloseGuard {
  const popupRef = useRef<HTMLElement | null>(null);
  const lastClickTargetRef = useModelSelectorClickTracking();

  useEffect(() => {
    const closeOnWindowBlur = () => {
      setOpen(false);
    };
    window.addEventListener("blur", closeOnWindowBlur);
    return () => window.removeEventListener("blur", closeOnWindowBlur);
  }, [setOpen]);

  const handleOpenChange = (next: boolean, eventDetails?: unknown) => {
    if (next) {
      setOpen(true);
      onOpen?.();
      return;
    }
    applyCloseWith(
      extractCloseReason(eventDetails),
      itemPressReason,
      isInsideMenuPopup(lastClickTargetRef.current, popupRef.current),
      setOpen,
    );
  };

  return {
    handleOpenChange,
    popupRef,
    setPopupNode: (node) => {
      popupRef.current = node;
    },
  };
}

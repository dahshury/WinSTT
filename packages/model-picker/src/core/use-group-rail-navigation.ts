"use client";

import type { RefObject } from "react";
import { useRef } from "react";
import { useRailScrollSpy } from "./use-rail-scroll-spy";

export interface UseGroupRailNavigationOptions {
  popupRef: RefObject<HTMLElement | null>;
  scrollContainerSelector: string;
  selectedGroupId: string | null;
  setActiveId: (id: string | null) => void;
}

export interface GroupRailNavigation {
  attachScrollSpy: (node: HTMLElement | null) => void;
  handleRailClick: (id: string) => void;
}

/**
 * Shared rail behavior for grouped model pickers. The picker still owns the
 * active id state, while this hook centralizes selected-group resync,
 * scroll-spy attachment, and click-to-section scrolling.
 */
export function useGroupRailNavigation({
  popupRef,
  scrollContainerSelector,
  selectedGroupId,
  setActiveId,
}: UseGroupRailNavigationOptions): GroupRailNavigation {
  const previousSelectedGroupRef = useRef<string | null>(selectedGroupId);
  if (previousSelectedGroupRef.current !== selectedGroupId) {
    previousSelectedGroupRef.current = selectedGroupId;
    setActiveId(selectedGroupId);
  }

  const railSpy = useRailScrollSpy({
    scrollContainerSelector,
    onActiveChange: (id) => setActiveId(id),
  });

  const handleRailClick = (id: string) => {
    railSpy.suppress();
    setActiveId(id);
    const root: ParentNode = popupRef.current ?? document;
    const target = root.querySelector<HTMLElement>(
      `[data-rail-section="${CSS.escape(id)}"]`,
    );
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return {
    attachScrollSpy: railSpy.attach,
    handleRailClick,
  };
}

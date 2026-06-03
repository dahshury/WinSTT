export interface HighlightRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

export function highlightRectsEqual(
  a: HighlightRect | null,
  b: HighlightRect | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height
  );
}

export function measureHighlightRect(
  el: HTMLElement,
  container: HTMLElement,
): HighlightRect {
  const c = container.getBoundingClientRect();
  // Live ancestor scale = visual size (rect) / layout size (offset). 1 when
  // untransformed; <1 mid open-animation. Guard the hidden (offset 0) case.
  const scaleX = container.offsetWidth ? c.width / container.offsetWidth : 1;
  const scaleY = container.offsetHeight ? c.height / container.offsetHeight : 1;
  const r = el.getBoundingClientRect();
  return {
    top: (r.top - c.top) / scaleY + container.scrollTop,
    left: (r.left - c.left) / scaleX + container.scrollLeft,
    width: r.width / scaleX,
    height: r.height / scaleY,
  };
}

export function findDataAttributeElement(
  container: HTMLElement,
  selector: string,
  getValue: (el: HTMLElement) => string | undefined,
  value: string,
): HTMLElement | null {
  if (value === "") {
    return null;
  }
  // Scan rather than querySelector with an attribute value so arbitrary ids
  // never need CSS.escape.
  for (const el of container.querySelectorAll<HTMLElement>(selector)) {
    if (getValue(el) === value) {
      return el;
    }
  }
  return null;
}

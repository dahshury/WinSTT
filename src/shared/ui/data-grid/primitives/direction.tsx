/**
 * Self-contained text-direction context for the vendored DiceUI grid.
 *
 * Upstream this wrapped `radix-ui`'s Direction provider; WinSTT has no Radix, so
 * this is a tiny standalone context exposing the same `useDirection` surface the
 * grid imports. No provider is rendered, so it resolves to the "ltr" default.
 */
import { createContext, use } from "react";

export type Direction = "ltr" | "rtl";

const DirectionContext = createContext<Direction>("ltr");

export function useDirection(localDirection?: Direction): Direction {
	const contextDirection = use(DirectionContext);
	return localDirection ?? contextDirection;
}

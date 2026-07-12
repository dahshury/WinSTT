import { createContext, useContext } from "react";

/**
 * True for anything rendered inside a {@link ModelSpecHoverCard} anchor. The
 * selected-model summary reads it to SUPPRESS its own name-truncation tooltip:
 * the rich spec card already surfaces the full model name (and much more), so
 * the little "name" tooltip would just be a redundant second popup fighting the
 * card for the same hover. Only set inside the hover-card wrapper — when the
 * wrapper is inert (no spec) the summary keeps its own tooltip as a fallback.
 */
const InsideModelSpecHoverCardContext = createContext(false);

export const InsideModelSpecHoverCardProvider =
	InsideModelSpecHoverCardContext.Provider;

export function useInsideModelSpecHoverCard(): boolean {
	return useContext(InsideModelSpecHoverCardContext);
}

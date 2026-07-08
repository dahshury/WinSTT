import { useRender } from "@base-ui/react/use-render";
import type { ReactElement } from "react";
import { type UsePendingOptions, usePending } from "./usePending";

/**
 * Wrapper that applies pending-state behaviour to its single child. This is the
 * Base-UI counterpart of DiceUI's Radix-`Slot`-based `Pending`: instead of
 * `Slot`, it uses `useRender` to merge {@link usePending}'s props onto the
 * child element (event handlers chain, `className`/`style` join, everything
 * else overwrites — the standard Base-UI merge).
 *
 * ```tsx
 * <Pending isPending={isSubmitting}>
 *   <Button>Submit</Button>
 * </Pending>
 * ```
 *
 * The child must forward props to a real element (any DOM element or a Base-UI
 * primitive). For custom components that don't forward arbitrary DOM props (our
 * `Toggle`, `Switcher`, …), reach for {@link PendingBadge} instead, which wraps
 * rather than merges.
 */

export interface PendingComponentProps extends UsePendingOptions {
	/** The interactive element to make pending. */
	children: ReactElement;
}

export function Pending({ isPending, children }: PendingComponentProps) {
	const { pendingProps } = usePending({ isPending });
	return useRender({ render: children, props: pendingProps });
}

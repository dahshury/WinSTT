/**
 * Minimal `Slot` (radix-ui replacement) for the vendored `sortable.tsx`.
 *
 * `sortable.tsx` uses `SlotPrimitive.Slot` to forward dnd-kit's drag props onto
 * a caller-provided child (the `asChild` pattern). This is a small standalone
 * implementation that merges props/refs onto a single child element, exported as
 * a `Slot` namespace object so the rewritten `import { Slot as SlotPrimitive }`
 * keeps working unchanged.
 */
import {
	cloneElement,
	type CSSProperties,
	type HTMLAttributes,
	isValidElement,
	type ReactElement,
	type Ref,
} from "react";
import { cn } from "@/shared/lib/cn";

type AnyProps = Record<string, unknown>;

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
	return (node: T | null) => {
		for (const ref of refs) {
			if (typeof ref === "function") ref(node);
			else if (ref) (ref as { current: T | null }).current = node;
		}
	};
}

function mergeProps(slotProps: AnyProps, childProps: AnyProps): AnyProps {
	const merged: AnyProps = { ...slotProps };
	for (const key of Object.keys(childProps)) {
		const slotValue = slotProps[key];
		const childValue = childProps[key];
		if (/^on[A-Z]/.test(key)) {
			if (typeof slotValue === "function" && typeof childValue === "function") {
				merged[key] = (...args: unknown[]) => {
					(childValue as (...a: unknown[]) => void)(...args);
					(slotValue as (...a: unknown[]) => void)(...args);
				};
			} else {
				merged[key] = childValue ?? slotValue;
			}
		} else if (key === "className") {
			merged[key] = cn(slotValue as string, childValue as string);
		} else if (key === "style") {
			merged[key] = {
				...(slotValue as CSSProperties),
				...(childValue as CSSProperties),
			};
		} else {
			merged[key] = childValue;
		}
	}
	return merged;
}

// eslint-disable-next-line react-doctor/only-export-components -- intentional radix-Slot-mirror: SlotComponent is exposed via the `Slot` namespace object (Slot.Slot) so `import { Slot as SlotPrimitive }` keeps working; exporting it directly would change the public shape
function SlotComponent({
	children,
	ref,
	...slotProps
}: HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> | undefined }) {
	if (!isValidElement(children)) return null;
	const child = children as ReactElement<AnyProps> & {
		ref?: Ref<HTMLElement>;
	};
	const childRef = child.ref;
	return cloneElement(child, {
		...mergeProps(slotProps as AnyProps, child.props),
		ref: ref ? mergeRefs(ref, childRef) : childRef,
	} as AnyProps);
}

/** Namespace object mirroring `radix-ui`'s `Slot` export shape. */
export const Slot = {
	Slot: SlotComponent,
	Slottable: ({ children }: { children?: ReactElement }) => children ?? null,
};

"use client";

import { AnimatePresence, m as motion } from "motion/react";
import {
	type ComponentPropsWithoutRef,
	createContext,
	type ReactNode,
	type Ref,
	type RefObject,
	useContext,
	useEffect,
	useRef,
} from "react";
import { cn } from "@/shared/lib/cn";
import { fontWeights } from "@/shared/lib/font-weight";
import { springs } from "@/shared/lib/springs";
import { useProximityHover } from "@/shared/lib/use-proximity-hover";

interface TableContextValue {
	activeIndex: number | null;
	registerItem: (index: number, element: HTMLElement | null) => void;
}

const TableContext = createContext<TableContextValue | null>(null);

export interface TableProps extends ComponentPropsWithoutRef<"table"> {
	containerClassName?: string;
	ref?: Ref<HTMLTableElement>;
}

export function Table({ children, className, containerClassName, ref, ...props }: TableProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const { activeIndex, handlers, itemRects, registerItem, sessionRef, measureItems } =
		useProximityHover(containerRef as RefObject<HTMLElement | null>);

	// Re-measure when children identity changes (rows added/removed). measureItems
	// is freshly created on every useProximityHover render but reads from stable
	// refs, so re-invocation is safe.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional re-measure on children change
	useEffect(() => {
		measureItems();
	}, [children]);

	const activeRect = activeIndex === null ? null : itemRects[activeIndex];

	return (
		<TableContext.Provider value={{ activeIndex, registerItem }}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: visual hover wrapper; semantic table is rendered inside */}
			<div
				className={cn("relative", containerClassName)}
				onMouseEnter={handlers.onMouseEnter}
				onMouseLeave={handlers.onMouseLeave}
				onMouseMove={handlers.onMouseMove}
				ref={containerRef}
				role="presentation"
			>
				<AnimatePresence>
					{activeRect ? (
						<motion.div
							animate={{
								height: activeRect.height,
								left: activeRect.left,
								opacity: 1,
								top: activeRect.top,
								width: activeRect.width,
							}}
							className="pointer-events-none absolute bg-surface-hover"
							exit={{ opacity: 0, transition: { duration: 0.06 } }}
							initial={{
								height: activeRect.height,
								left: activeRect.left,
								opacity: 0,
								top: activeRect.top,
								width: activeRect.width,
							}}
							key={sessionRef.current}
							transition={{ ...springs.fast, opacity: { duration: 0.08 } }}
						/>
					) : null}
				</AnimatePresence>
				<table className={cn("w-full border-collapse text-body", className)} ref={ref} {...props}>
					{children}
				</table>
			</div>
		</TableContext.Provider>
	);
}

export type TableHeaderProps = ComponentPropsWithoutRef<"thead"> & {
	ref?: Ref<HTMLTableSectionElement>;
};

export function TableHeader({ className, ref, ...props }: TableHeaderProps) {
	return <thead className={cn(className)} ref={ref} {...props} />;
}

export type TableBodyProps = ComponentPropsWithoutRef<"tbody"> & {
	ref?: Ref<HTMLTableSectionElement>;
};

export function TableBody({ className, ref, ...props }: TableBodyProps) {
	return <tbody className={cn(className)} ref={ref} {...props} />;
}

export interface TableRowProps extends ComponentPropsWithoutRef<"tr"> {
	index?: number;
	ref?: Ref<HTMLTableRowElement>;
}

export function TableRow({ className, index, ref, style, ...props }: TableRowProps) {
	const internalRef = useRef<HTMLTableRowElement | null>(null);
	const ctx = useContext(TableContext);

	useEffect(() => {
		if (index === undefined || !ctx) {
			return;
		}
		ctx.registerItem(index, internalRef.current);
		return () => ctx.registerItem(index, null);
	}, [ctx, index]);

	const isBodyRow = index !== undefined;
	const activeIdx = ctx?.activeIndex ?? null;
	const hideBorder =
		activeIdx !== null &&
		((isBodyRow && (index === activeIdx || index === activeIdx - 1)) ||
			(!isBodyRow && activeIdx === 0));

	const setRef = (node: HTMLTableRowElement | null) => {
		internalRef.current = node;
		if (typeof ref === "function") {
			ref(node);
		} else if (ref) {
			(ref as { current: HTMLTableRowElement | null }).current = node;
		}
	};

	return (
		<tr
			className={cn(
				"group/row relative z-raised border-b transition-[border-color] duration-100",
				hideBorder ? "border-transparent" : "border-border",
				isBodyRow && activeIdx === index && "is-active",
				className
			)}
			data-proximity-index={index}
			ref={setRef}
			style={{
				fontVariationSettings: isBodyRow ? fontWeights.normal : fontWeights.semibold,
				...style,
			}}
			{...props}
		/>
	);
}

export type TableHeadProps = ComponentPropsWithoutRef<"th"> & {
	ref?: Ref<HTMLTableCellElement>;
};

export function TableHead({ className, ref, ...props }: TableHeadProps) {
	return (
		<th
			className={cn("px-3 py-2 text-left font-medium text-foreground", className)}
			ref={ref}
			{...props}
		/>
	);
}

export type TableCellProps = ComponentPropsWithoutRef<"td"> & {
	ref?: Ref<HTMLTableCellElement>;
};

export function TableCell({ className, ref, ...props }: TableCellProps) {
	return (
		<td
			className={cn(
				"px-3 py-2 text-foreground-muted transition-colors duration-100",
				"group-[.is-active]/row:text-foreground",
				className
			)}
			ref={ref}
			{...props}
		/>
	);
}

export interface TableEmptyProps {
	children: ReactNode;
	colSpan: number;
}

export function TableEmpty({ children, colSpan }: TableEmptyProps) {
	return (
		<tr>
			<td className="px-3 py-6 text-center text-body-sm text-foreground-muted" colSpan={colSpan}>
				{children}
			</td>
		</tr>
	);
}

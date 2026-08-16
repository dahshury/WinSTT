"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

const ROW_SELECTOR = "[data-nav-row]:not([disabled])";

function moveFocus(
	container: HTMLElement,
	from: EventTarget | null,
	step: number,
) {
	const rows = [...container.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
	if (rows.length === 0) {
		return;
	}
	const index = rows.indexOf(from as HTMLElement);
	const next = index < 0 ? 0 : (index + step + rows.length) % rows.length;
	rows[next]?.focus();
}

function focusEdge(container: HTMLElement, edge: "first" | "last") {
	const rows = [...container.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
	const target = edge === "first" ? rows[0] : rows.at(-1);
	target?.focus();
}

/**
 * The root view's list of filter dimensions. Rows stay ordinary tabbable
 * buttons — Tab still walks them — with arrow keys layered on top so the list
 * can be driven the way a menu is: Up/Down between rows, Right (or Enter) to
 * drill in.
 */
export function NavList({
	ariaLabel,
	children,
}: {
	ariaLabel: string;
	children: ReactNode;
}) {
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const container = event.currentTarget;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveFocus(container, event.target, 1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			moveFocus(container, event.target, -1);
			return;
		}
		if (event.key === "Home") {
			event.preventDefault();
			focusEdge(container, "first");
			return;
		}
		if (event.key === "End") {
			event.preventDefault();
			focusEdge(container, "last");
		}
	};

	// `role="group"` rather than listbox/menu: these rows are not options to be
	// selected, they are navigation buttons that open a sub-view.
	return (
		<div
			aria-label={ariaLabel}
			className="flex flex-col p-1"
			onKeyDown={onKeyDown}
			role="group"
		>
			{children}
		</div>
	);
}

/**
 * A single row: what the dimension is, what it is currently set to, and a
 * chevron promising there is more behind it. The value summary is the whole
 * point — the root view has to answer "what is filtered right now?" without
 * making anyone open all five sub-views to find out.
 */
export function NavRow({
	badge,
	disabled = false,
	icon,
	label,
	onKeyDown: onKeyDownProp,
	onOpen,
	value,
	viewId,
}: {
	/** Count pill for multi-select dimensions ("3"), shown before the value. */
	badge?: number | undefined;
	disabled?: boolean | undefined;
	icon: IconSvgElement;
	label: string;
	/** Extra key handling for the row itself — the data grid clears a dimension
	 *  with Backspace/Delete straight from its row. Runs before the built-in
	 *  ArrowRight handling and can `preventDefault()` to take over. */
	onKeyDown?: ((event: KeyboardEvent<HTMLButtonElement>) => void) | undefined;
	onOpen: (viewId: string) => void;
	/** Current selection, rendered as an accent chip. Omit for "no selection". */
	value?: string | null | undefined;
	/** The view this row drills into — also the anchor focus returns to. */
	viewId: string;
}) {
	const open = () => onOpen(viewId);
	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		onKeyDownProp?.(event);
		if (event.defaultPrevented) {
			return;
		}
		if (event.key === "ArrowRight") {
			event.preventDefault();
			open();
		}
	};

	return (
		<BaseButton
			className={cn(
				"flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start outline-none transition-colors",
				"hover:bg-foreground/[0.045] focus-visible:ring-2 focus-visible:ring-accent",
				disabled && "pointer-events-none opacity-50",
			)}
			data-nav-row
			data-nav-row-id={viewId}
			disabled={disabled}
			onClick={open}
			onKeyDown={onKeyDown}
			type="button"
		>
			<span className="flex min-w-0 items-center gap-2">
				<HugeiconsIcon
					aria-hidden="true"
					className="size-4 shrink-0 text-foreground-muted"
					icon={icon}
				/>
				<span className="truncate font-medium text-body-sm text-foreground">
					{label}
				</span>
			</span>
			<span className="flex shrink-0 items-center gap-1.5">
				{badge && badge > 0 ? (
					<span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 font-semibold text-[9px] text-on-accent tabular-nums leading-none">
						{badge}
					</span>
				) : null}
				{value ? (
					<span className="max-w-32 truncate rounded-full bg-accent/15 px-2 py-0.5 font-medium text-[11px] text-accent">
						{value}
					</span>
				) : null}
				<HugeiconsIcon
					aria-hidden="true"
					className="size-4 text-foreground-muted"
					icon={ArrowRight01Icon}
				/>
			</span>
		</BaseButton>
	);
}

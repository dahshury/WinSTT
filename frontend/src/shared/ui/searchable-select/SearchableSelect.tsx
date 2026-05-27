import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import {
	SurfaceProvider,
	surfaceClasses,
	surfaceHighlightedBg,
	surfaceSelectedBg,
	useSurface,
} from "@/shared/lib/surface";
import type { SelectOption } from "@/shared/ui/select";
import "./searchable-select.css";

export interface SearchableSelectProps {
	disabled?: boolean;
	/**
	 * Interactive node pinned inside the trigger, just left of the chevron —
	 * stays visible whether the popup is open or closed. Pointer/click events
	 * are stopped from bubbling so it can't toggle the popup. Used by the TTS
	 * voice picker for the "preview selected voice" play/stop control.
	 */
	inputTrailing?: ReactNode;
	onChange: (value: string) => void;
	onOpenChange?: (open: boolean) => void;
	options: readonly SelectOption[];
	placeholder?: string;
	/**
	 * Per-row trailing node rendered at the end of each option in the popup.
	 * Pointer/click events are stopped so pressing it previews that row
	 * without selecting (or closing) the combobox.
	 */
	renderItemTrailing?: (option: SelectOption) => ReactNode;
	value: string;
}

function getItemLabel(item: SelectOption | null): string {
	return item ? item.label : "";
}

function Badge({ text }: { text: string }) {
	return (
		<span className="pointer-events-none inline-flex h-4 min-w-[22px] shrink-0 items-center justify-center rounded-xs border border-border bg-surface-1 px-1 font-mono font-semibold text-[10px] text-foreground-secondary uppercase tracking-wider">
			{text}
		</span>
	);
}

/**
 * Wraps an interactive control rendered inside the combobox so its pointer
 * and click events don't reach Base UI's input/item handlers (which would
 * otherwise toggle the popup or commit the row).
 *
 * The semantics are "this group is a toolbar of decorations sitting inside a
 * listbox row". `role="toolbar"` is the WAI-ARIA pattern for that — and it's
 * an interactive container role, so it satisfies the
 * react-doctor/no-static-element-interactions + click-events-have-key-events
 * rules without forcing a real button (which would steal focus/Enter from the
 * actual child controls). Keyboard activation flows through whichever inner
 * `<button>` is rendered as a child; the shim itself never needs onKey*.
 */
function StopBubble({ children, className }: { children: ReactNode; className?: string }) {
	const swallow = (e: { stopPropagation: () => void }) => e.stopPropagation();
	return (
		<div
			className={className}
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

function OptionIcon({ icon }: { icon: NonNullable<SelectOption["icon"]> }) {
	return (
		<HugeiconsIcon
			aria-hidden="true"
			className="pointer-events-none shrink-0 text-foreground-muted"
			icon={icon}
			size={14}
		/>
	);
}

function ItemTrailing({
	item,
	render,
}: {
	item: SelectOption;
	render: (option: SelectOption) => ReactNode;
}) {
	return <StopBubble className="ml-auto flex shrink-0 items-center">{render(item)}</StopBubble>;
}

export function SearchableSelect({
	options,
	value,
	onChange,
	onOpenChange,
	placeholder = "Search…",
	disabled = false,
	inputTrailing,
	renderItemTrailing,
}: SearchableSelectProps) {
	const selected = options.find((o) => o.id === value) ?? null;

	const substrate = useSurface();
	const inputLevel = Math.min(substrate + 1, 8);
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	const highlightLevel = Math.min(popupLevel + 1, 8);
	// Selected row sits a step above hover so the current selection is
	// instantly readable against the popup — replaces the old translucent
	// accent tint which washed out against surface-N.
	const selectedLevel = Math.min(popupLevel + 2, 8);

	// Measure the rendered badge/icon decoration so the input gets exactly
	// the right left-padding, regardless of how wide the badge text is
	// ("EN" vs "AUTO" vs "YUE"). A fixed estimate would either clip wider
	// badges or waste whitespace for short ones.
	const decorationRef = useRef<HTMLSpanElement>(null);
	const [decorationWidth, setDecorationWidth] = useState(0);
	const hasDecoration = Boolean(selected?.badge || selected?.icon);
	useLayoutEffect(() => {
		// When there's no decoration the measured width is irrelevant —
		// `decorationPadding` already short-circuits to 0 via `hasDecoration`,
		// so we skip the redundant state write and only sync on real nodes.
		const node = hasDecoration ? decorationRef.current : null;
		if (!node) {
			return;
		}
		const sync = () => setDecorationWidth(node.offsetWidth);
		sync();
		const observer = new ResizeObserver(sync);
		observer.observe(node);
		return () => {
			observer.disconnect();
		};
	}, [hasDecoration]);
	// 8px matches `left-2` on the decoration span; the trailing 8px is the
	// gap between the decoration and the typed text.
	const decorationPadding = hasDecoration ? 8 + decorationWidth + 8 : 0;

	return (
		<Combobox.Root
			defaultValue={selected}
			disabled={disabled}
			items={[...options]}
			itemToStringLabel={getItemLabel}
			onOpenChange={onOpenChange}
			onValueChange={(item: SelectOption | null) => {
				if (item) {
					onChange(item.id);
				}
			}}
			value={selected}
		>
			{/* `isolation-isolate` forces a stacking context on this wrapper so the
			    badge's positioned children can never escape and overlap other
			    comboboxes / popovers elsewhere on the page. */}
			<div className="relative isolate flex w-full items-center">
				{hasDecoration ? (
					<span
						className="pointer-events-none absolute top-1/2 left-2 flex -translate-y-1/2 items-center gap-1.5"
						ref={decorationRef}
					>
						{selected?.badge ? <Badge text={selected.badge} /> : null}
						{selected?.icon ? <OptionIcon icon={selected.icon} /> : null}
					</span>
				) : null}
				<Combobox.Input
					className={`flex h-8 w-full items-center rounded-sm ${surfaceClasses(inputLevel)} ${inputTrailing ? "pr-16" : "pr-7"} pl-2.5 font-inherit text-body text-foreground leading-normal outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 disabled:cursor-not-allowed disabled:opacity-40`}
					placeholder={placeholder}
					style={decorationPadding > 0 ? { paddingLeft: `${decorationPadding}px` } : undefined}
				/>
				{inputTrailing ? (
					<StopBubble className="absolute top-1/2 right-7 flex -translate-y-1/2 items-center">
						{inputTrailing}
					</StopBubble>
				) : null}
				<Combobox.Trigger
					aria-label="Open popup"
					className="absolute top-1/2 right-1.5 flex size-5 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim"
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
							className={`searchable-select-popup w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-sm ${surfaceClasses(popupLevel, popupShadow)} py-1 [max-height:min(15rem,var(--available-height))]`}
						>
							<Combobox.Empty className="searchable-select-empty">No results found.</Combobox.Empty>
							<Combobox.List className="outline-none">
								{(item: SelectOption) => (
									<Combobox.Item
										className={`searchable-select-item mx-1 flex cursor-default select-none items-center gap-1.5 rounded-xs px-2.5 py-[7px] text-body text-foreground leading-normal outline-none ${surfaceHighlightedBg(highlightLevel)} ${surfaceSelectedBg(selectedLevel)} data-[selected]:font-medium data-[selected]:text-foreground data-[selected]:shadow-[inset_2px_0_0_0_var(--color-accent)]`}
										key={item.id}
										value={item}
									>
										<span className="flex w-3 shrink-0 items-center justify-center">
											<Combobox.ItemIndicator>
												<CheckIcon />
											</Combobox.ItemIndicator>
										</span>
										{item.badge ? <Badge text={item.badge} /> : null}
										{item.icon ? <OptionIcon icon={item.icon} /> : null}
										<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
											{item.label}
										</span>
										{renderItemTrailing ? (
											<ItemTrailing item={item} render={renderItemTrailing} />
										) : null}
									</Combobox.Item>
								)}
							</Combobox.List>
						</Combobox.Popup>
					</Combobox.Positioner>
				</SurfaceProvider>
			</Combobox.Portal>
		</Combobox.Root>
	);
}

function CheckIcon() {
	return (
		<svg
			aria-hidden="true"
			fill="currentcolor"
			height="10"
			role="img"
			viewBox="0 0 10 10"
			width="10"
		>
			<title>Selected</title>
			<path d="M9.16 1.12C9.51 1.35 9.6 1.81 9.38 2.16L5.14 8.66C5.02 8.84 4.82 8.97 4.6 9C4.39 9.02 4.17 8.95 4.01 8.81L1.25 6.31C0.94 6.03 0.92 5.56 1.19 5.25C1.47 4.94 1.95 4.92 2.25 5.2L4.36 7.1L8.12 1.34C8.35 0.99 8.81 0.9 9.16 1.12Z" />
		</svg>
	);
}

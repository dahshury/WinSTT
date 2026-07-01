import { Toggle } from "@base-ui/react/toggle";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CSSProperties, FocusEvent as ReactFocusEvent } from "react";
import { cn } from "@/shared/lib/cn";
import { fontWeights } from "@/shared/lib/font-weight";
import { DemoPreview } from "@/shared/ui/demo-preview";
import { Tooltip } from "@/shared/ui/tooltip";
import type { SwitcherOption } from "./switcher-option";

type SwitcherCssVars = CSSProperties & {
	"--switcher-color"?: string | undefined;
};

export interface SwitcherOptionToggleProps<T extends string> {
	/** Stamped on the toggle's `data-switcher-index` attribute so the parent
	 *  Switcher can find every option button via a single `querySelectorAll`
	 *  call inside its measurement effect — avoiding per-option callback refs
	 *  (and the stable-identity gymnastics they need to not retrigger every
	 *  render). */
	dataIndex: number;
	fullWidth: boolean | undefined;
	/** When true the option fills its grid cell (`w-full`) instead of flexing —
	 *  used by the Switcher's `columns` grid layout. */
	grid?: boolean;
	isHovered: boolean;
	isSelected: boolean;
	onBlur: (e: ReactFocusEvent<HTMLButtonElement>) => void;
	onFocus: (e: ReactFocusEvent<HTMLButtonElement>) => void;
	onMouseEnter: () => void;
	onMouseLeave: () => void;
	option: SwitcherOption<T>;
}

export function SwitcherOptionToggle<T extends string>({
	dataIndex,
	option,
	isSelected,
	isHovered,
	fullWidth,
	grid,
	onBlur,
	onFocus,
	onMouseEnter,
	onMouseLeave,
}: SwitcherOptionToggleProps<T>) {
	const colored = option.color !== undefined;
	const style: SwitcherCssVars | undefined = colored
		? { "--switcher-color": option.color }
		: undefined;
	const textClass = (() => {
		if (colored && isSelected) {
			return "text-surface-1";
		}
		if (colored) {
			return "text-[var(--switcher-color)]";
		}
		if (isSelected || isHovered) {
			return "text-foreground";
		}
		// Unselected options sit on the elevated switcher substrate (up to
		// surface-7 inside a nested ElevatedSurface, e.g. the modifier level
		// switcher), where -muted (oklch 55%) still reads as faint and blends
		// into the track. -secondary (73%) keeps unmarked choices clearly
		// legible; the selected/hovered label stays ahead via full -foreground +
		// semibold + the lifted pill.
		return "text-foreground-secondary";
	})();
	const toggleEl = (
		<Toggle
			className={cn(
				"relative z-raised inline-flex h-8 items-center justify-center gap-1.5 bg-transparent px-2.5 font-medium text-[13px] outline-none transition-colors focus-visible:outline-none",
				textClass,
				option.disabled && "cursor-not-allowed opacity-60",
				grid ? "w-full" : fullWidth && "flex-1",
			)}
			data-switcher-index={dataIndex}
			disabled={option.disabled}
			onBlur={onBlur}
			onFocus={onFocus}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
			style={style}
			value={option.value}
		>
			{option.iconNode ? (
				<span aria-hidden="true" className="flex shrink-0 items-center">
					{option.iconNode}
				</span>
			) : option.icon ? (
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0"
					icon={option.icon}
					size={16}
				/>
			) : null}
			<span className="inline-grid whitespace-nowrap">
				<span
					aria-hidden="true"
					className="invisible col-start-1 row-start-1"
					style={{ fontVariationSettings: fontWeights.semibold }}
				>
					{option.label}
				</span>
				<span
					className="col-start-1 row-start-1 transition-[font-variation-settings] duration-100"
					style={{
						fontVariationSettings: isSelected
							? fontWeights.semibold
							: fontWeights.normal,
					}}
				>
					{option.label}
				</span>
			</span>
		</Toggle>
	);
	// A per-option preview reveals a short looping demo of this exact option on
	// hover (one preview per button — not one for the whole group). Takes
	// precedence over a text tooltip when both are set.
	if (option.preview && !option.disabled) {
		return (
			<DemoPreview demo={option.preview} side="top">
				{toggleEl}
			</DemoPreview>
		);
	}
	// A per-option tooltip (with optional footer hint) wraps the whole segment.
	// Only used for non-disabled options — a disabled option renders a native
	// disabled button which doesn't fire hover, so those rely on the badge.
	if (option.tooltip) {
		return (
			<Tooltip
				content={option.tooltip}
				footer={option.tooltipFooter}
				side="top"
			>
				{toggleEl}
			</Tooltip>
		);
	}
	return toggleEl;
}

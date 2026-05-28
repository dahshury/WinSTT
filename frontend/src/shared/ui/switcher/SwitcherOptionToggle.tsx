import { Toggle } from "@base-ui/react/toggle";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CSSProperties, FocusEvent as ReactFocusEvent } from "react";
import { cn } from "@/shared/lib/cn";
import { fontWeights } from "@/shared/lib/font-weight";
import type { SwitcherOption } from "./Switcher";

type SwitcherCssVars = CSSProperties & { "--switcher-color"?: string | undefined };

export interface SwitcherOptionToggleProps<T extends string> {
	/** Stamped on the toggle's `data-switcher-index` attribute so the parent
	 *  Switcher can find every option button via a single `querySelectorAll`
	 *  call inside its measurement effect — avoiding per-option callback refs
	 *  (and the stable-identity gymnastics they need to not retrigger every
	 *  render). */
	dataIndex: number;
	fullWidth: boolean | undefined;
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
		// foreground-dim (oklch 38%) is barely legible against the elevated
		// switcher substrate; -muted (55%) keeps the unselected options
		// clearly readable while still ranking visually below the
		// selected/hovered label.
		return "text-foreground-muted";
	})();
	return (
		<Toggle
			className={cn(
				"relative z-raised inline-flex items-center justify-center gap-1.5 bg-transparent px-3 py-1 font-medium text-body-sm outline-none transition-colors focus-visible:outline-none",
				textClass,
				option.disabled && "cursor-not-allowed opacity-40",
				fullWidth && "flex-1"
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
			{option.icon ? (
				<HugeiconsIcon aria-hidden="true" className="shrink-0" icon={option.icon} size={13} />
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
						fontVariationSettings: isSelected ? fontWeights.semibold : fontWeights.normal,
					}}
				>
					{option.label}
				</span>
			</span>
		</Toggle>
	);
}

import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { FormControl } from "@/shared/ui/form-control";
import { SettingResetButton } from "./SettingResetButton";

export interface SettingFieldProps {
	/** Optional one-line description rendered beneath the label. */
	caption?: string;
	/** The control itself (slider, stepper, select, …). Omit for a label-only row. */
	children?: ReactNode;
	/** Extra classes forwarded to the underlying FormControl root. */
	className?: string;
	/**
	 * Schema default for this setting. When provided alongside `onReset`, the
	 * reset button is disabled while `value` already equals it. Ignored if
	 * `isDefault` is given.
	 */
	defaultValue?: unknown;
	/** Dim + make the control non-interactive (e.g. gated by a parent toggle). */
	disabled?: boolean;
	/**
	 * Name of the setting this one depends on. When `disabled` and a `tooltip`
	 * are both present, the localized "(disabled because …)" suffix
	 * (`settings.disabledReason`) is appended to the tooltip so the control
	 * stays discoverable while explaining why it is inert.
	 */
	disabledReason?: string;
	/**
	 * Explicit "currently at the schema default" flag. Use for derived
	 * comparisons that `value`/`defaultValue` can't express. Takes precedence
	 * over `value`/`defaultValue`.
	 */
	isDefault?: boolean;
	label?: string;
	/** Element rendered inline on the trailing edge of the label (e.g. a Toggle). */
	labelAddon?: ReactNode;
	/** "stacked" (default, wide control below) or "row" (compact control beside the label). */
	layout?: "stacked" | "row";
	/**
	 * Restore the setting to its default. When set, a per-setting reset button
	 * is rendered in the label's trailing slot (unless `hideReset`). When
	 * omitted, no reset button appears.
	 */
	onReset?: () => void;
	/** Suppress the reset button even though `onReset` is set (e.g. gated rows). */
	hideReset?: boolean;
	/** Help text shown in the info-icon tooltip next to the label. */
	tooltip?: string;
	/** Current value — compared against `defaultValue` to drive the reset button. */
	value?: unknown;
}

/**
 * A single setting row. Wraps {@link FormControl} and folds in the two pieces
 * of boilerplate that every scalar setting otherwise repeats by hand:
 *
 * 1. the per-setting "reset to default" button — wired from `value`/
 *    `defaultValue` (or an explicit `isDefault`) + `onReset`; and
 * 2. the "(disabled because X)" tooltip suffix — appended automatically when
 *    `disabled` + `disabledReason` are set.
 *
 * Everything else (label, caption, tooltip, layout, a `labelAddon` toggle)
 * passes straight through to FormControl.
 */
export function SettingField({
	caption,
	children,
	className,
	defaultValue,
	disabled,
	disabledReason,
	isDefault,
	label,
	labelAddon,
	layout,
	onReset,
	hideReset,
	tooltip,
	value,
}: SettingFieldProps) {
	const ts = useTranslations("settings");

	const atDefault =
		isDefault ??
		(defaultValue !== undefined ? Object.is(value, defaultValue) : true);
	const showReset = onReset !== undefined && !hideReset;

	const effectiveTooltip =
		tooltip && disabled && disabledReason
			? `${tooltip} ${ts("disabledReason", { name: disabledReason })}`
			: tooltip;

	return (
		<FormControl
			caption={caption}
			className={className}
			disabled={disabled}
			label={label}
			labelAddon={labelAddon}
			labelTrailing={
				showReset ? (
					<SettingResetButton isDefault={atDefault} onReset={onReset} />
				) : undefined
			}
			layout={layout}
			tooltip={effectiveTooltip}
		>
			{children}
		</FormControl>
	);
}

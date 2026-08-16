import { HugeiconsIcon } from "@hugeicons/react";
import { Children, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import type { CreatableComboboxItem } from "@/shared/ui/creatable-combobox";
import { PresetNavCombobox } from "@/shared/ui/creatable-combobox";
import { PendingBadge } from "@/shared/ui/pending";
import { Toggle } from "@/shared/ui/toggle";
import { Tooltip } from "@/shared/ui/tooltip";
import type { AssignableFeature } from "../model/configuration-assignment";
import type { SavedConfiguration } from "../model/configurations";
import { FEATURE_ICONS, FEATURE_LABEL_KEY } from "../model/feature-meta";
import { iconForPostProcessingProfileId } from "../model/profile-icons";
import type { FeatureAssignment } from "../model/use-configuration-workbench";
import type { TranslateFn } from "./types";

/**
 * One consumer, one row: WHETHER it runs and WHICH profile it runs, side by
 * side.
 *
 * The two questions used to sit in different regions of the tab — a segmented
 * chip strip in the section header for the switches, a separate "Per-mode
 * profiles" block in the body for the assignments. Cause and effect were a
 * scroll apart, and a contiguous chip strip made three INDEPENDENT booleans read
 * as one mutually-exclusive mode picker. Here each feature owns its switch, its
 * picker, and any extras it needs, so the row is the whole answer for that
 * feature.
 *
 * The row is ALWAYS rendered, on or off. A disabled feature fades its icon tile
 * but keeps its name, caption and both controls at full strength: the toggle is
 * how you turn the feature on, and picking a profile before enabling is a
 * legitimate — and common — order of operations. Nothing here is ever unmounted,
 * `inert`, or dimmed below readable contrast.
 *
 * Presentational: every write goes back out through `onToggle` / `onAssign` so
 * the panel can route the switch through the full per-feature controller
 * (model preflight on the way on, warm/unload spinner while VRAM moves). A bare
 * `enabled` write from here would skip both.
 */

// `as const` so the values stay literal message keys — a `Record<_, string>`
// annotation would widen them and `t()` only accepts known keys. Lives here
// rather than next to FEATURE_LABEL_KEY because `feature-meta.ts` is shared with
// the profile editor's "Used by" row, which has no captions.
const FEATURE_CAPTION_KEY = {
	dictation: "assignDictationCaption",
	transforms: "assignTransformsCaption",
	readAloud: "assignReadAloudCaption",
} as const satisfies Record<AssignableFeature, string>;

export interface FeatureRowProps {
	assignment: FeatureAssignment;
	/** Feature-specific extras, rendered as indented sub-rows under this row. */
	children?: ReactNode;
	configurations: readonly SavedConfiguration[];
	/** External block (listen mode) — greys BOTH controls, unlike the row's own
	 *  off-state dim, which leaves them usable. */
	disabled?: boolean;
	disabledTooltip?: ReactNode;
	onAssign: (configurationId: string) => void;
	/** Opens the profile editor (the renamed Playground). */
	onCreateProfile: () => void;
	onToggle: (next: boolean) => void;
	/** The model is warming into / draining out of VRAM. */
	pending?: boolean;
	t: TranslateFn;
}

export function FeatureRow({
	assignment,
	children,
	configurations,
	disabled = false,
	disabledTooltip,
	onAssign,
	onCreateProfile,
	onToggle,
	pending = false,
	t,
}: FeatureRowProps) {
	const featureLabel = t(FEATURE_LABEL_KEY[assignment.feature]);
	const items: CreatableComboboxItem[] = configurations.map((config) => ({
		id: config.id,
		label: config.name,
		icon: iconForPostProcessingProfileId(config.id),
	}));

	// Prev/next cycle THIS feature's profile, wrapping at either end. Only
	// meaningful with two or more saved profiles (the arrows don't render below
	// that, but guard anyway so a stale click can't index past the list).
	const step = (offset: -1 | 1) => {
		if (configurations.length < 2) {
			return;
		}
		const index = configurations.findIndex(
			(config) => config.id === assignment.configurationId,
		);
		const from = index >= 0 ? index : 0;
		const next =
			configurations[
				(from + offset + configurations.length) % configurations.length
			];
		if (next) {
			onAssign(next.id);
		}
	};

	// A switch is unusable while its model is mid-transition (a second flip would
	// queue another load/unload), while an external block is in force (listen
	// mode), or when no profile resolves at all — there would be no prompt to run.
	const toggleBlocked = pending || !assignment.canEnable || disabled;
	const toggleTooltip = disabled
		? disabledTooltip
		: assignment.canEnable
			? undefined
			: t("assignNeedsPreset");
	const toggle = (
		<PendingBadge pending={pending}>
			<Toggle
				aria-label={t("featureToggleAria", { feature: featureLabel })}
				checked={assignment.enabled}
				disabled={toggleBlocked}
				onCheckedChange={onToggle}
			/>
		</PendingBadge>
	);

	// Extras arrive as JSX that is often a conditional `null`; `Children.toArray`
	// drops those, so an all-empty set renders no sub-row container (and no stray
	// gap) rather than an empty indented box.
	const extras = Children.toArray(children);

	return (
		<div className="flex flex-col gap-2 py-3">
			<div className="flex items-center gap-3">
				{/* Only the ICON TILE fades when the feature is off. `settings-dim` is
				    40% opacity, and everywhere else in the app it is paired with
				    `pointer-events-none` on genuinely inert content — this row is never
				    inert (the switch is how you turn the feature ON, and assigning a
				    profile first is normal), and all three rows are off on a fresh
				    install. Fading the name and caption there put them at roughly 3.3:1
				    and 1.6:1 on the surface, under the 4.5:1 AA floor, with no
				    "inactive component" exemption to lean on. Text keeps full contrast;
				    the muted tile and the off switch carry the state. */}
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<span
						aria-hidden="true"
						className={cn(
							"flex size-7 shrink-0 items-center justify-center rounded bg-activity/10 text-activity ring-1 ring-activity/20 transition-opacity duration-200 ease-out",
							!assignment.enabled && "settings-dim",
						)}
					>
						<HugeiconsIcon icon={FEATURE_ICONS[assignment.feature]} size={13} />
					</span>
					<div className="flex min-w-0 flex-col gap-0.5">
						<span className="truncate font-medium text-body text-foreground leading-tight">
							{featureLabel}
						</span>
						<span className="truncate text-body-sm text-foreground-muted leading-snug">
							{t(FEATURE_CAPTION_KEY[assignment.feature])}
						</span>
					</div>
				</div>
				{/* Its own labelled group: Base UI's combobox sets `aria-labelledby`,
				    which wins over `aria-label`, so without this wrapper the three
				    pickers would be indistinguishable to a screen reader (and to a
				    test). */}
				<div aria-label={featureLabel} className="shrink-0" role="group">
					<PresetNavCombobox
						className="w-56 min-w-0 shrink-0"
						disabled={disabled}
						footerAction={{
							label: t("perModeProfilesAdd"),
							onSelect: onCreateProfile,
						}}
						items={items}
						labels={{
							create: (name) => t("modifierPresetCreate", { name }),
							delete: t("playgroundDeletePreset"),
							empty: t("modifierPresetEmpty"),
							group: t("featureProfileAria", { feature: featureLabel }),
							next: "Next profile",
							placeholder: t("modifierPresetPlaceholder"),
							previous: "Previous profile",
							reorder: (item) => `Drag ${item.label} to reorder`,
							reset: "Reset to saved settings",
							save: "Overwrite profile with current settings",
						}}
						onSelect={onAssign}
						onStep={step}
						value={assignment.configurationId}
					/>
				</div>
				<div className="shrink-0">
					{toggleTooltip ? (
						// A disabled Switch swallows pointer events, so the tooltip hangs
						// off a wrapper — same shape SettingSection uses.
						<Tooltip content={toggleTooltip}>
							<span className="inline-flex">{toggle}</span>
						</Tooltip>
					) : (
						toggle
					)}
				</div>
			</div>
			{extras.length > 0 ? (
				// Indented to clear the icon tile (size-7 + gap-3), so an extra reads
				// as belonging to the feature above it rather than to the section.
				<div className="flex flex-col ps-10">{extras}</div>
			) : null}
		</div>
	);
}

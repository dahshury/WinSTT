import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	Delete02Icon,
	PencilEdit01Icon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import type { ContextAppEntry } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { generateId } from "@/shared/lib/generate-id";
import {
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import {
	CreatableCombobox,
	type CreatableComboboxItem,
} from "@/shared/ui/creatable-combobox";
import { IconButton } from "@/shared/ui/icon-button";
import { usePopupSurfaceLevels } from "@/shared/ui/select";
import { Toggle } from "@/shared/ui/toggle";
import {
	configSnapshotFromSavedConfiguration,
	normalizeExeInput,
	type AppProfileRule,
} from "../model/app-profile-rules";
import type { SavedConfiguration } from "../model/configuration-types";
import { iconForPostProcessingProfileId } from "../model/profile-icons";
import { useAppProfileIndicatorStore } from "../model/use-app-profile-indicator";
import {
	buildAppProfileAppOptions,
	reconcileAppProfileRules,
} from "./app-profile-rules-grid-helpers";
import { AppProfileRuleDialog } from "./AppProfileRuleDialog";

interface EditingRule {
	isNew: boolean;
	rule: AppProfileRule;
}

function AppIcon({
	app,
	label,
}: {
	app: ContextAppEntry | undefined;
	label: string;
}) {
	if (app?.icon) {
		return (
			<img alt="" className="size-6 rounded object-contain" src={app.icon} />
		);
	}
	return (
		<span className="flex size-6 shrink-0 items-center justify-center rounded border border-border bg-surface-2 font-semibold text-[10px] uppercase">
			{label.charAt(0) || "?"}
		</span>
	);
}

export function ConfigurationPickerCell({
	configurations,
	disabled,
	onSelect,
	value,
}: {
	configurations: readonly SavedConfiguration[];
	disabled: boolean;
	onSelect: (id: string) => void;
	value: string;
}) {
	const t = useTranslations("llm");
	const { triggerLevel } = usePopupSurfaceLevels({ selfElevate: false });
	const showNavigation = configurations.length >= 2;
	const items: CreatableComboboxItem[] = configurations.map(
		(configuration) => ({
			icon: iconForPostProcessingProfileId(configuration.id),
			id: configuration.id,
			label: configuration.name,
		}),
	);
	const selectAtOffset = (offset: -1 | 1) => {
		const currentIndex = configurations.findIndex(
			(configuration) => configuration.id === value,
		);
		const startIndex = currentIndex >= 0 ? currentIndex : 0;
		const nextIndex =
			(startIndex + offset + configurations.length) % configurations.length;
		const next = configurations[nextIndex];
		if (next) {
			onSelect(next.id);
		}
	};
	const navButtonClass = cn(
		"h-8 w-8 shrink-0 bg-transparent text-foreground-dim transition-colors focus-visible:ring-inset focus-visible:ring-offset-0",
		!disabled &&
			cn(
				surfaceHoverBg(Math.min(triggerLevel + 1, 8)),
				"hover:text-foreground",
			),
	);

	return (
		<div
			aria-label={t("appProfileConfiguration")}
			className={cn(
				"flex size-full min-w-0 items-center",
				showNavigation &&
					cn("overflow-hidden rounded-lg", surfaceClasses(triggerLevel)),
			)}
			role="group"
		>
			{showNavigation ? (
				<Button
					aria-label="Previous preset"
					className={cn(
						navButtonClass,
						"border-divider-strong border-e border-solid",
					)}
					disabled={disabled}
					onClick={() => selectAtOffset(-1)}
				>
					<HugeiconsIcon icon={ArrowLeft01Icon} size={15} />
				</Button>
			) : null}
			<CreatableCombobox
				bareInput={showNavigation}
				className="min-w-0 flex-1"
				createLabel={(name) => name}
				disabled={disabled}
				emptyLabel={t("appProfileSelectConfiguration")}
				hideSelectedCheck
				inputClassName={
					showNavigation
						? "rounded-none ps-2 pe-6 focus-visible:ring-inset focus-visible:ring-offset-0"
						: ""
				}
				items={items}
				onSelect={onSelect}
				placeholder={t("appProfileSelectConfiguration")}
				value={value}
			/>
			{showNavigation ? (
				<Button
					aria-label="Next preset"
					className={cn(
						navButtonClass,
						"border-divider-strong border-s border-solid",
					)}
					disabled={disabled}
					onClick={() => selectAtOffset(1)}
				>
					<HugeiconsIcon icon={ArrowRight01Icon} size={15} />
				</Button>
			) : null}
		</div>
	);
}

function matcherSummary(rule: AppProfileRule, titleMatcher: string): string {
	return [rule.appExe, rule.titlePattern ? titleMatcher : "", rule.urlPattern]
		.filter(Boolean)
		.join(" · ");
}

/**
 * One rule, one line: "<app> → <profile>", then the switch and the two verbs
 * that act on it. The app area is the dialog launcher, so the thing you click to
 * change *what this rule matches* is the thing that shows what it currently
 * matches — rather than a pencil in a column of its own.
 */
function AppProfileRuleRow({
	apps,
	configurations,
	enabled,
	isActive,
	onDelete,
	onEdit,
	onSelectConfiguration,
	onToggleEnabled,
	rule,
}: {
	apps: readonly ContextAppEntry[];
	configurations: readonly SavedConfiguration[];
	enabled: boolean;
	isActive: boolean;
	onDelete: () => void;
	onEdit: () => void;
	onSelectConfiguration: (configurationId: string) => void;
	onToggleEnabled: (checked: boolean) => void;
	rule: AppProfileRule;
}) {
	const t = useTranslations("llm");
	const substrate = useSurface();
	const app = apps.find(
		(entry) =>
			normalizeExeInput(entry.exe || entry.id) ===
			normalizeExeInput(rule.appExe),
	);
	const label =
		app?.label || rule.appExe || rule.titlePattern || rule.urlPattern;
	const summary = matcherSummary(
		rule,
		t("appProfileMatcherTitle", { title: rule.titlePattern }),
	);
	// The app label alone does not identify a ROW: two rules can target the same
	// executable and differ only by window title or domain. That distinction is
	// already on screen in `summary`, so fold it into the accessible name too —
	// otherwise the rows are indistinguishable to a screen reader (and to a test)
	// exactly when telling them apart matters most.
	const accessibleName =
		summary && summary !== label ? `${label} — ${summary}` : label;

	return (
		// Each row is its own labelled group: the combobox inside publishes its own
		// name, so without this a screen reader (and a test) could not tell which
		// rule a control belongs to.
		<div
			aria-label={t("appProfileRuleAria", { app: accessibleName })}
			className="flex items-center gap-2"
			role="group"
		>
			<Button
				aria-label={t("appProfileEditRule")}
				className={cn(
					"flex min-w-0 flex-1 items-center justify-start gap-2 rounded-lg px-2 py-1.5 text-left text-body transition-colors active:scale-[0.99]",
					enabled && surfaceHoverBg(Math.min(substrate + 1, 8)),
				)}
				disabled={!enabled}
				onClick={onEdit}
			>
				<AppIcon app={app} label={label} />
				<span className="min-w-0 flex-1">
					<span className="block truncate font-medium text-foreground">
						{label}
					</span>
					{/* Only when it adds something: with no app metadata the summary is
					    just the exe again, and repeating it reads as a rendering bug. */}
					{summary && summary !== label ? (
						<span className="block truncate text-foreground-muted text-xs-tight">
							{summary}
						</span>
					) : null}
				</span>
				<HugeiconsIcon
					className="shrink-0 text-foreground-muted"
					icon={PencilEdit01Icon}
					size={13}
				/>
			</Button>
			<HugeiconsIcon
				aria-hidden="true"
				className="shrink-0 text-foreground-dim"
				icon={ArrowRight01Icon}
				size={13}
			/>
			<div className="w-64 shrink-0">
				<ConfigurationPickerCell
					configurations={configurations}
					disabled={!enabled}
					onSelect={onSelectConfiguration}
					value={rule.configurationId}
				/>
			</div>
			{isActive ? (
				<span
					className="shrink-0 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-accent text-xs-tight"
					role="status"
				>
					{t("appProfileActiveNow")}
				</span>
			) : null}
			<Toggle
				aria-label={t("appProfileToggleRule", {
					configuration: rule.configurationName,
				})}
				checked={rule.enabled}
				disabled={!enabled}
				onCheckedChange={onToggleEnabled}
			/>
			<IconButton
				aria-label={t("appProfileDeleteRule")}
				disabled={!enabled}
				icon={<HugeiconsIcon icon={Delete02Icon} size={14} />}
				onClick={onDelete}
			/>
		</div>
	);
}

interface AppProfileRulesGridProps {
	apps: ContextAppEntry[];
	configurations: SavedConfiguration[];
	enabled: boolean;
	fallback: string;
	onChange: (rules: AppProfileRule[]) => void;
	rules: AppProfileRule[];
}

/**
 * Per-app overrides as a flat list of sentences, not a table.
 *
 * There are typically zero to three rules here, so the data grid this replaced
 * was paying for row numbers, selection, pagination and sorting that never had
 * anything to sort — and hid the rule's own content behind a pencil in a column
 * whose header was a verb. A rule now reads left to right on one line.
 */
export function AppProfileRulesGrid({
	apps,
	configurations,
	enabled,
	fallback,
	onChange,
	rules,
}: AppProfileRulesGridProps) {
	const t = useTranslations("llm");
	const substrate = useSurface();
	const [editing, setEditing] = useState<EditingRule | null>(null);
	// The "a rule just fired" indicator belongs on the rule it describes: in the
	// panel header it named an app and a configuration with no way to see which
	// row that was. Keyed on the broadcast's RULE ID, which is what the native
	// side resolved — matching on the foreground exe instead lit up every row
	// sharing that exe (two title-scoped Chrome rules) and no row at all for a
	// title- or url-only rule, whose `appExe` is empty by design.
	const activeRuleId =
		useAppProfileIndicatorStore((state) => state.current)?.ruleId ?? "";
	const appOptions = buildAppProfileAppOptions(apps, rules);
	const canAdd = enabled && configurations.length > 0;

	const updateRules = (next: AppProfileRule[]) => {
		onChange(reconcileAppProfileRules(next, configurations));
	};
	const createRule = (): AppProfileRule => {
		const configuration = configurations[0];
		if (!configuration) {
			throw new Error("A configuration is required");
		}
		// Seed with an app no rule claims yet. Always seeding the first option made
		// "Add rule" twice in a row produce two rules matching the same executable
		// with nothing to tell them apart — including in their accessible names.
		const claimed = new Set(rules.map((existing) => existing.appExe));
		const seedApp =
			appOptions.find((option) => !claimed.has(option.value)) ?? appOptions[0];
		const rule: AppProfileRule = {
			appExe: seedApp?.value ?? "",
			config: configSnapshotFromSavedConfiguration(configuration.config),
			configurationId: configuration.id,
			configurationName: configuration.name,
			enabled: true,
			id: generateId(),
			titlePattern: "",
			urlPattern: "",
		};
		setEditing({ isNew: true, rule });
		return rule;
	};
	const closeEditor = () => {
		if (editing?.isNew) {
			updateRules(rules.filter((rule) => rule.id !== editing.rule.id));
		}
		setEditing(null);
	};
	const saveEditedRule = (editedRule: AppProfileRule) => {
		updateRules(
			rules.map((rule) => (rule.id === editedRule.id ? editedRule : rule)),
		);
		setEditing(null);
	};
	// The grid's footer used to append whatever `createRule` returned; that append
	// moves here unchanged, because `saveEditedRule` maps over `rules` by id and
	// `closeEditor` discards the brand-new rule on cancel — both need the rule to
	// already be in the list while the dialog is open.
	const addRule = () => {
		if (!canAdd) {
			return;
		}
		updateRules([...rules, createRule()]);
	};

	return (
		<div aria-disabled={!enabled} className="flex flex-col gap-3">
			{rules.length === 0 ? (
				<p className="px-2 py-1 text-body-sm text-foreground-muted">
					{t("appProfilesEmpty")}
				</p>
			) : (
				<div className="flex flex-col gap-1">
					{rules.map((rule) => (
						<AppProfileRuleRow
							apps={apps}
							configurations={configurations}
							enabled={enabled}
							isActive={activeRuleId === rule.id}
							key={rule.id}
							onDelete={() =>
								updateRules(
									rules.filter((candidate) => candidate.id !== rule.id),
								)
							}
							onEdit={() => setEditing({ isNew: false, rule })}
							onSelectConfiguration={(configurationId) =>
								updateRules(
									rules.map((candidate) =>
										candidate.id === rule.id
											? { ...candidate, configurationId }
											: candidate,
									),
								)
							}
							onToggleEnabled={(checked) =>
								updateRules(
									rules.map((candidate) =>
										candidate.id === rule.id
											? { ...candidate, enabled: checked }
											: candidate,
									),
								)
							}
							rule={rule}
						/>
					))}
				</div>
			)}
			<Button
				aria-label={t("appProfileAddRule")}
				className={cn(
					"flex w-full items-center justify-start gap-2 rounded-lg px-2 py-1.5 text-foreground-muted transition-colors",
					canAdd &&
						cn(
							surfaceHoverBg(Math.min(substrate + 1, 8)),
							"hover:text-foreground",
						),
				)}
				disabled={!canAdd}
				onClick={addRule}
			>
				<HugeiconsIcon icon={PlusSignIcon} size={13} />
				<span className="font-medium text-body-sm">
					{t("appProfileAddRule")}
				</span>
			</Button>
			<div className="flex items-center justify-between rounded-lg border border-border bg-surface-1 px-3 py-2 text-body">
				<span className="text-foreground-muted">
					{t("appProfileEverythingElse")}
				</span>
				<span className="font-medium text-foreground">{fallback}</span>
			</div>
			{editing ? (
				<AppProfileRuleDialog
					key={editing.rule.id}
					apps={apps}
					onClose={closeEditor}
					onSave={saveEditedRule}
					rule={editing.rule}
				/>
			) : null}
		</div>
	);
}

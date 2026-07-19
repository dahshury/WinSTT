import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { useTranslations } from "use-intl";
import type { ContextAppEntry } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { generateId } from "@/shared/lib/generate-id";
import { surfaceClasses, surfaceHoverBg } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import {
	CreatableCombobox,
	type CreatableComboboxItem,
} from "@/shared/ui/creatable-combobox";
import {
	EditableRecordsGrid,
	getDataGridSelectColumn,
	getFilterFn,
} from "@/shared/ui/data-grid";
import { Toggle } from "@/shared/ui/toggle";
import { usePopupSurfaceLevels } from "@/shared/ui/select";
import {
	configSnapshotFromSavedConfiguration,
	normalizeExeInput,
	type AppProfileRule,
} from "../model/app-profile-rules";
import type { SavedConfiguration } from "../model/configuration-types";
import { iconForPostProcessingProfileId } from "../model/profile-icons";
import {
	buildAppProfileAppOptions,
	reconcileAppProfileRules,
} from "./app-profile-rules-grid-helpers";
import { AppProfileRuleDialog } from "./AppProfileRuleDialog";

const EDITABLE_COLUMNS: readonly string[] = [];

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

interface AppProfileRulesGridProps {
	apps: ContextAppEntry[];
	configurations: SavedConfiguration[];
	enabled: boolean;
	fallback: string;
	onChange: (rules: AppProfileRule[]) => void;
	rules: AppProfileRule[];
}

export function AppProfileRulesGrid({
	apps,
	configurations,
	enabled,
	fallback,
	onChange,
	rules,
}: AppProfileRulesGridProps) {
	const t = useTranslations("llm");
	const [editing, setEditing] = useState<EditingRule | null>(null);
	const filterFn = getFilterFn<AppProfileRule>();
	const appOptions = buildAppProfileAppOptions(apps, rules);

	const updateRules = (next: AppProfileRule[]) => {
		onChange(reconcileAppProfileRules(next, configurations));
	};
	const createRule = (): AppProfileRule => {
		const configuration = configurations[0];
		if (!configuration) {
			throw new Error("A configuration is required");
		}
		const rule: AppProfileRule = {
			appExe: appOptions[0]?.value ?? "",
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

	const columns: ColumnDef<AppProfileRule>[] = [
		getDataGridSelectColumn<AppProfileRule>({ readOnly: !enabled }),
		{
			accessorKey: "configurationId",
			cell: ({ row }) => (
				<ConfigurationPickerCell
					configurations={configurations}
					disabled={!enabled}
					onSelect={(configurationId) =>
						updateRules(
							rules.map((rule) =>
								rule.id === row.original.id
									? { ...rule, configurationId }
									: rule,
							),
						)
					}
					value={row.original.configurationId}
				/>
			),
			enableSorting: false,
			filterFn,
			header: () => <span>{t("appProfileConfiguration")}</span>,
			id: "configurationId",
			meta: { label: t("appProfileConfiguration"), stretch: false },
			maxSize: 300,
			minSize: 225,
			size: 270,
		},
		{
			accessorFn: (rule) =>
				matcherSummary(
					rule,
					t("appProfileMatcherTitle", { title: rule.titlePattern }),
				),
			cell: ({ row }) => {
				const rule = row.original;
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
				return (
					<Button
						aria-label={t("appProfileEditRule")}
						className="flex size-full min-w-0 items-center justify-between gap-3 rounded px-2 text-left text-body transition-colors hover:bg-surface-6 active:scale-[0.98]"
						disabled={!enabled}
						onClick={() => setEditing({ isNew: false, rule })}
					>
						<span className="flex min-w-0 items-center gap-2">
							<AppIcon app={app} label={label} />
							<span className="min-w-0">
								<span className="block truncate font-medium text-foreground">
									{label}
								</span>
								<span className="block truncate text-caption text-foreground-muted">
									{summary || t("appProfileEditRule")}
								</span>
							</span>
						</span>
						<HugeiconsIcon
							className="shrink-0 text-foreground-muted"
							icon={PencilEdit01Icon}
							size={14}
						/>
					</Button>
				);
			},
			enableSorting: false,
			header: () => <span>{t("appProfileEditRule")}</span>,
			id: "matcher",
			meta: { label: t("appProfileEditRule"), stretch: false },
			maxSize: 240,
			minSize: 180,
			size: 200,
		},
		{
			accessorKey: "enabled",
			cell: ({ row }) => {
				const rule = row.original;
				return (
					<div className="flex size-full items-center justify-center">
						<Toggle
							aria-label={t("appProfileToggleRule", {
								configuration: rule.configurationName,
							})}
							checked={rule.enabled}
							disabled={!enabled}
							onCheckedChange={(checked) =>
								updateRules(
									rules.map((candidate) =>
										candidate.id === rule.id
											? { ...candidate, enabled: checked }
											: candidate,
									),
								)
							}
						/>
					</div>
				);
			},
			enableSorting: false,
			header: () => (
				<span className="sr-only">
					{t("appProfileToggleRule", { configuration: "" })}
				</span>
			),
			id: "actions",
			meta: { stretch: true },
			size: 72,
		},
	];

	return (
		<div aria-disabled={!enabled} className="flex flex-col gap-3">
			<EditableRecordsGrid
				canAdd={enabled && configurations.length > 0}
				columns={columns}
				createRow={createRule}
				data={rules}
				editableColumnIds={EDITABLE_COLUMNS}
				focusColumnId="configurationId"
				isEmptyRow={() => false}
				onChange={updateRules}
				readOnly={!enabled}
				rowHeight="medium"
				showSortControl={false}
			/>
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

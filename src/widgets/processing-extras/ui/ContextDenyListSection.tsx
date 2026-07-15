import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingField,
	useSettingsStore,
} from "@/entities/setting";
import { type ContextAppEntry, listContextApps } from "@/shared/api/ipc-client";
import {
	buildContextAppOptions,
	ContextAppIcon,
} from "@/shared/ui/context-app-combobox";
import { EditableListCombobox } from "@/shared/ui/editable-list-combobox";

/**
 * Editable deny-list for context capture, rendered as a manage-a-set combobox
 * (`EditableListCombobox`): the field shows a count summary when closed, and
 * opening it reveals a searchable dropdown where each entry can be edited in
 * place or deleted. Running apps are offered as icon-aware suggestions, while
 * the create row still accepts an arbitrary executable or domain.
 *
 * Two kinds of entries — both stored as plain strings; the matcher (Rust side,
 * `winstt`'s context snapshot; mirrors the reference `isDeniedByList`)
 * distinguishes them by the `.exe` suffix:
 *
 *  - `chrome.exe`, `1password.exe` — exe-name match against the
 *    foreground process basename.
 *  - `bankofamerica.com`, `chase.com` — URL host suffix match;
 *    automatically covers subdomains.
 *
 * Rendered directly under the Context-awareness toggle in the Processing
 * tab so the privacy story stays in one place: enable context → see what gets
 * skipped. Visibility is owned by the parent (shown only while context
 * awareness is enabled). Entries are normalised (trimmed + lower-cased) before
 * they're stored, which both matches the case-insensitive matcher and keeps
 * the combobox's duplicate detection honest.
 */
export function ContextDenyListSection() {
	const general = useSettingsStore((s) => s.settings.general);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("general");
	const tc = useTranslations("common");
	const denyList = general?.contextDenyList ?? [];
	const defaultDenyList = DEFAULT_SETTINGS.general.contextDenyList;
	const [apps, setApps] = useState<ContextAppEntry[]>([]);
	const [appsStatus, setAppsStatus] = useState<
		"idle" | "loading" | "loaded" | "error"
	>("idle");
	const appSuggestions = buildContextAppOptions(apps).map((app) => ({
		value: app.exe,
		label: app.label,
		leading: <ContextAppIcon icon={app.icon ?? null} label={app.label} />,
		trailing: (
			<span className="max-w-[8rem] truncate font-mono text-[11px] text-foreground-muted">
				{app.exe}
			</span>
		),
	}));

	useEffect(() => {
		if (appsStatus !== "loading") {
			return;
		}
		let cancelled = false;
		listContextApps()
			.then((next) => {
				if (!cancelled) {
					setApps(next);
					setAppsStatus("loaded");
				}
			})
			.catch((error) => {
				if (!cancelled) {
					console.error("[context-deny-list] listContextApps failed:", error);
					setAppsStatus("error");
				}
			});
		return () => {
			cancelled = true;
		};
	}, [appsStatus]);
	// The deny-list is a set, so compare order-insensitively — re-adding a
	// removed entry can shuffle insertion order without changing membership.
	const isDefaultDenyList =
		denyList.toSorted().join(" ") === defaultDenyList.toSorted().join(" ");

	return (
		<SettingField
			isDefault={isDefaultDenyList}
			label={t("contextDenyList")}
			onReset={() => update({ contextDenyList: [...defaultDenyList] })}
			tooltip={t("contextDenyListTooltip")}
		>
			<EditableListCombobox
				cancelAriaLabel={tc("cancel")}
				createLabel={(entry) => `${t("contextDenyListAdd")} "${entry}"`}
				editAriaLabel={(entry) => `${t("contextDenyListEdit")} "${entry}"`}
				emptyLabel={t("contextDenyListEmpty")}
				inputAriaLabel={t("contextDenyList")}
				normalize={(raw) => raw.trim().toLowerCase()}
				onChange={(next) => update({ contextDenyList: next })}
				onOpenChange={(open) => {
					if (!open || appsStatus === "loading" || appsStatus === "loaded") {
						return;
					}
					setAppsStatus("loading");
				}}
				placeholder={t("contextDenyListPlaceholder")}
				removeAriaLabel={(entry) => `${t("contextDenyListRemove")} "${entry}"`}
				saveAriaLabel={tc("save")}
				summaryLabel={(count) => t("contextDenyListSummary", { count })}
				suggestions={appSuggestions}
				value={denyList}
			/>
		</SettingField>
	);
}

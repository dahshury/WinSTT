import { useTranslations } from "use-intl";
import { DEFAULT_SETTINGS, SettingResetButton, useSettingsStore } from "@/entities/setting";
import { FormControl } from "@/shared/ui/form-control";
import { TagInput } from "@/shared/ui/tag-input";

/**
 * Editable deny-list for context capture, rendered as a creatable tags input:
 * type an entry and commit it inline, remove an entry via its chip.
 *
 * Two kinds of entries — both stored as plain strings; the matcher in
 * `electron/lib/context-snapshot.ts#isDeniedByList` distinguishes them
 * by the `.exe` suffix:
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
 * the `TagInput`'s duplicate detection honest.
 */
export function ContextDenyListSection() {
	const general = useSettingsStore((s) => s.settings.general);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("general");
	const denyList = general?.contextDenyList ?? [];
	const defaultDenyList = DEFAULT_SETTINGS.general.contextDenyList;
	// The deny-list is a set, so compare order-insensitively — re-adding a
	// removed entry can shuffle insertion order without changing membership.
	const isDefaultDenyList = [...denyList].sort().join(" ") === [...defaultDenyList].sort().join(" ");

	return (
		<FormControl
			label={t("contextDenyList")}
			labelTrailing={
				<SettingResetButton
					isDefault={isDefaultDenyList}
					onReset={() => update({ contextDenyList: [...defaultDenyList] })}
				/>
			}
			tooltip={t("contextDenyListTooltip")}
		>
			<TagInput
				createLabel={(entry) => `${t("contextDenyListAdd")} "${entry}"`}
				inputAriaLabel={t("contextDenyList")}
				normalize={(raw) => raw.trim().toLowerCase()}
				onChange={(next) => update({ contextDenyList: next })}
				placeholder={t("contextDenyListPlaceholder")}
				removeAriaLabel={(entry) => `${t("contextDenyListRemove")} "${entry}"`}
				value={denyList}
			/>
		</FormControl>
	);
}

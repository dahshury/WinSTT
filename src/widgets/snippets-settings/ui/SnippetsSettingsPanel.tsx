import { StickyNote01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { VocabularyTransfer } from "@/features/vocabulary-transfer";
import { Badge } from "@/shared/ui/badge";
import { SnippetsTable } from "./SnippetsTable";

export function SnippetsSettingsPanel() {
	const snippets = useSettingsStore((s) => s.settings.snippets) ?? [];
	const updateSnippets = useSettingsStore((s) => s.updateSnippets);
	const t = useTranslations("snippets");

	return (
		<SettingSection
			boxed
			description={t("description")}
			headerAction={
				snippets.length > 0 ? (
					<Badge
						aria-hidden="true"
						className="tabular-nums"
						variant="secondary"
					>
						{snippets.length}
					</Badge>
				) : undefined
			}
			icon={StickyNote01Icon}
			title={t("title")}
		>
			<div className="flex flex-col gap-3 pt-2 pb-4">
				<VocabularyTransfer kind="snippets" />
				<SnippetsTable entries={snippets} onChange={updateSnippets} />
			</div>
		</SettingSection>
	);
}

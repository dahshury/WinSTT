"use client";

import { EyeIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { FormControl } from "@/shared/ui/form-control";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";
import { Toggle } from "@/shared/ui/toggle";

/**
 * Context-awareness toggle + opt-in dialog. Lives in the LLM tab because
 * the captured window text only matters when the LLM cleanup / Transforms
 * pipeline is on — context-awareness alone with no LLM provider is a no-op.
 *
 * Toggle-on path: show the warning dialog → confirm persists the flag;
 * cancel reverts. Toggle-off path: persist immediately (no consent needed
 * to disable a privacy-affecting feature).
 */
export function ContextAwarenessSection() {
	const general = useSettingsStore((s) => s.settings.general);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("general");
	const enabled = general?.contextAwareness ?? false;
	const [dialogOpen, setDialogOpen] = useState(false);

	const handleToggle = (next: boolean): void => {
		if (next) {
			setDialogOpen(true);
			return;
		}
		update({ contextAwareness: false });
	};

	return (
		<SettingSection icon={EyeIcon} title={t("contextAwarenessSection")}>
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
				<FormControl
					caption={t("contextAwarenessCaption")}
					label={t("contextAwareness")}
					tooltip={t("contextAwarenessTooltip")}
				>
					<Toggle checked={enabled} onCheckedChange={handleToggle} />
				</FormControl>
			</div>
			<OptInDialog
				body={t("contextAwarenessDialogBody")}
				cancelLabel={t("contextAwarenessDialogCancel")}
				confirmLabel={t("contextAwarenessDialogConfirm")}
				onCancel={() => update({ contextAwareness: false })}
				onConfirm={() => update({ contextAwareness: true })}
				onOpenChange={setDialogOpen}
				open={dialogOpen}
				title={t("contextAwarenessDialogTitle")}
			/>
		</SettingSection>
	);
}

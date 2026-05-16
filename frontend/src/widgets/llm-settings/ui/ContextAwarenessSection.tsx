"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useSettingsStore } from "@/entities/setting";
import { FormControl } from "@/shared/ui/form-control";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";
import { Toggle } from "@/shared/ui/toggle";

/**
 * Context-awareness control. Rendered inside the "Dictation post-processing"
 * subsection because the captured window text is only ever fed into the
 * dictation LLM cleanup path (relay.ts → processText); the Transforms path
 * never passes context. Content-only — the surrounding SettingSubsection
 * owns the title/toggle/box.
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
		<>
			<FormControl
				caption={t("contextAwarenessCaption")}
				label={t("contextAwareness")}
				tooltip={t("contextAwarenessTooltip")}
			>
				<Toggle checked={enabled} onCheckedChange={handleToggle} />
			</FormControl>
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
		</>
	);
}

import { useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { shouldConfirmSeparateCleanup } from "@/shared/lib/asr-prompting";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";

export function useSeparateCleanupConfirmation() {
	const [pending, setPending] = useState<(() => void) | null>(null);
	const t = useTranslations("asrPrompt");
	return {
		request: (action: () => void) => {
			if (shouldConfirmSeparateCleanup(useSettingsStore.getState().settings)) {
				setPending(() => action);
			} else {
				action();
			}
		},
		dialog: (
			<OptInDialog
				body={t("warningBody")}
				cancelLabel={t("cancel")}
				confirmLabel={t("continue")}
				onCancel={() => setPending(null)}
				onConfirm={() => {
					useSettingsStore
						.getState()
						.updateModelSettings({ asrAllowSeparateCleanup: true });
					pending?.();
					setPending(null);
				}}
				onOpenChange={(open) => {
					if (!open) {
						setPending(null);
					}
				}}
				open={pending !== null}
				title={t("warningTitle")}
			/>
		),
	};
}

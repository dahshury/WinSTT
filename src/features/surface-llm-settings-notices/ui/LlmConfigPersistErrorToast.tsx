"use client";

import { DatabaseLockedIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import {
	ToastDismissButton,
	ToastShell,
	useAutoDismiss,
} from "@/shared/ui/toast";
import {
	type ConfigurationPersistenceAction,
	useConfigurationPersistenceErrorStore,
} from "@/widgets/llm-settings/model/configurations";

const AUTO_DISMISS_MS = 8000;

/** Maps the failed mutation to its localized body (`llm.configPersistFailed*`). */
function bodyKey(
	action: ConfigurationPersistenceAction,
):
	| "configPersistFailedSave"
	| "configPersistFailedUpdate"
	| "configPersistFailedDelete"
	| "configPersistFailedReorder" {
	switch (action) {
		case "save":
			return "configPersistFailedSave";
		case "update":
			return "configPersistFailedUpdate";
		case "delete":
			return "configPersistFailedDelete";
		case "reorder":
			return "configPersistFailedReorder";
	}
}

/**
 * Surfaces a failure to persist the saved LLM-configuration list to
 * localStorage (audit #44). The list still works in-memory for the session, but
 * the write did NOT land — without this toast the UI silently claimed a config
 * was "saved"/"deleted" that will vanish on restart. Single-slot store: the
 * newest failure replaces any prior one. Auto-dismisses after 8s.
 *
 * Mounted in the settings window, where the LLM-configuration mutations run.
 */
export function LlmConfigPersistErrorToast() {
	const current = useConfigurationPersistenceErrorStore((s) => s.current);
	const clear = useConfigurationPersistenceErrorStore((s) => s.clear);
	const t = useTranslations("llm");

	useAutoDismiss(current, clear, AUTO_DISMISS_MS);

	if (!current) {
		return null;
	}

	return (
		<ToastShell
			ariaLive="assertive"
			className="fixed right-4 bottom-4 z-toast w-[420px] max-w-[90vw]"
			role="alert"
			tone="error"
		>
			<div className="flex items-start gap-2">
				<HugeiconsIcon
					aria-hidden="true"
					className="mt-0.5 shrink-0 text-error"
					icon={DatabaseLockedIcon}
					size={16}
				/>
				<div className="flex flex-1 flex-col">
					<span className="font-medium text-body text-foreground">
						{t("configPersistFailedTitle")}
					</span>
					<span className="text-foreground-muted text-sm">
						{t(bodyKey(current.action))}
					</span>
				</div>
				<ToastDismissButton onClick={clear} />
			</div>
		</ToastShell>
	);
}

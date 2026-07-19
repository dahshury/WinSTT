"use client";

import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import {
	type SettingsWarning,
	useSettingsHydrationStore,
} from "@/entities/setting";
import {
	ToastDismissButton,
	ToastShell,
	useAutoDismiss,
} from "@/shared/ui/toast";

const AUTO_DISMISS_MS = 8000;

/**
 * Maps a non-fatal settings warning to its localized message. The `detail`
 * carries the affected section / hotkey names and is interpolated into the
 * `{sections}` / `{hotkeys}` placeholder for the two kinds that name them.
 */
function warningMessage(
	warning: SettingsWarning,
	t: ReturnType<typeof useTranslations<"settings">>,
): string {
	const detail = warning.detail ?? "";
	switch (warning.kind) {
		case "defaulted-sections":
			return t("warningDefaultedSections", { sections: detail });
		case "hotkey-rewrite":
			return t("warningHotkeyRewrite", { hotkeys: detail });
		case "save-failed":
			return t("warningSaveFailed");
	}
}

/**
 * A single warning notice. `save-failed` self-clears on the standard toast
 * timer (the change is kept dirty and retried, so the notice is transient and
 * a repeat failure re-pushes it, restarting the countdown). The load-time
 * data-integrity kinds (#45 defaulted sections, #26 hotkey rewrites) stay
 * until dismissed — they report data the user set that couldn't be read.
 */
function WarningToast({
	warning,
	onDismiss,
}: {
	warning: SettingsWarning;
	onDismiss: () => void;
}) {
	const t = useTranslations("settings");
	useAutoDismiss(
		warning.kind === "save-failed" ? warning : null,
		onDismiss,
		AUTO_DISMISS_MS,
	);

	return (
		<ToastShell
			ariaLive="polite"
			className="pointer-events-auto"
			role="alert"
			tone="error"
		>
			<div className="flex items-start gap-2">
				<HugeiconsIcon
					aria-hidden="true"
					className="mt-0.5 shrink-0 text-error"
					icon={AlertCircleIcon}
					size={16}
				/>
				<span className="flex-1 text-body text-foreground">
					{warningMessage(warning, t)}
				</span>
				<ToastDismissButton onClick={onDismiss} />
			</div>
		</ToastShell>
	);
}

/**
 * Renders the non-fatal settings-hydration warnings raised on load (a persisted
 * section fell back to defaults #45, colliding hotkeys were reset #26, or a
 * backend save was rejected #46) as a stack of dismissible notices. The store
 * collapses repeats of the same kind, so the stack stays bounded.
 *
 * Mounted in BOTH the main window (RootLayout) and the settings window, because
 * either window's `useSyncSettings` can push a warning into its own store.
 */
export function SettingsWarningToasts() {
	const warnings = useSettingsHydrationStore((s) => s.warnings);
	const dismissWarning = useSettingsHydrationStore((s) => s.dismissWarning);

	if (warnings.length === 0) {
		return null;
	}

	return (
		<div className="pointer-events-none fixed right-4 bottom-4 z-toast flex w-[420px] max-w-[90vw] flex-col gap-2">
			{warnings.map((warning) => (
				<WarningToast
					key={warning.id}
					onDismiss={() => dismissWarning(warning.id)}
					warning={warning}
				/>
			))}
		</div>
	);
}

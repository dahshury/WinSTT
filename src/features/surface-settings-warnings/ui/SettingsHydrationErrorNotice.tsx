"use client";

import { AlertCircleIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsHydrationStore } from "@/features/update-settings";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { ToastShell } from "@/shared/ui/toast";

/**
 * Main-window surface for a FATAL settings-hydration failure (audit #39). The
 * settings window already shows its own hydration error (`SettingsHydrationPanel`),
 * but the main window had none — so if the backend settings load failed here,
 * persistence + server sync were silently disabled for the session with no way
 * to recover short of a restart.
 *
 * This renders a small, non-blocking notice while `status === "error"` with a
 * Retry button that bumps `retryToken` via `requestRetry()`; `useSyncSettings`
 * re-runs `settingsLoadStrict` on that change, so a transient failure is
 * recoverable in place. While the re-hydration is in flight (status flips back
 * to `loading` after a retry) the notice shows a "reconnecting" state so the
 * action reads as acknowledged.
 */
export function SettingsHydrationErrorNotice() {
	const status = useSettingsHydrationStore((s) => s.status);
	const requestRetry = useSettingsHydrationStore((s) => s.requestRetry);
	const t = useTranslations("settings");
	const [retrying, setRetrying] = useState(false);
	const detailsLevel = Math.min(useSurface() + 4, 8);

	// A fresh error (re-hydration failed again) re-arms the Retry action.
	useEffect(() => {
		if (status === "error") {
			setRetrying(false);
		}
	}, [status]);

	const isRetrying = retrying && status === "loading";
	if (status !== "error" && !isRetrying) {
		return null;
	}

	const handleRetry = () => {
		setRetrying(true);
		requestRetry();
	};

	return (
		<ToastShell
			ariaLive="assertive"
			className="fixed right-4 bottom-4 z-toast w-[380px] max-w-[90vw]"
			role="alert"
			tone="error"
		>
			<div className="flex items-start gap-2">
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"mt-0.5 shrink-0",
						isRetrying ? "text-foreground-muted" : "text-error",
					)}
					icon={isRetrying ? RefreshIcon : AlertCircleIcon}
					size={16}
				/>
				<div className="flex flex-1 flex-col">
					{isRetrying ? (
						<span className="text-body text-foreground-secondary">
							{t("hydrationRetrying")}
						</span>
					) : (
						<>
							<span className="font-medium text-body text-foreground">
								{t("hydrationErrorTitle")}
							</span>
							<span className="text-foreground-muted text-sm">
								{t("hydrationErrorBody")}
							</span>
							<div className="mt-2 flex justify-end gap-2">
								<Button
									className={cn(
										"flex items-center gap-1 rounded border border-border px-3 py-1 text-foreground-secondary text-xs transition-colors hover:bg-surface-elevated",
										surfaceBg(detailsLevel),
									)}
									onClick={handleRetry}
								>
									<HugeiconsIcon icon={RefreshIcon} size={11} />
									{t("hydrationRetry")}
								</Button>
							</div>
						</>
					)}
				</div>
			</div>
		</ToastShell>
	);
}

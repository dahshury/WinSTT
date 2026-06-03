import { Cancel01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import { useTranslations } from "use-intl";
import { onServerRestartRequired } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { useRestartNotice } from "../model/restart-notice-store";

// Longer than the swap toast — this is an instruction the user has to act
// on (restart their server), not just an error to acknowledge.
const AUTO_DISMISS_MS = 15_000;

/**
 * Notice for the dev-only case where a startup-only setting changed but the
 * STT server is user-run (not reference-managed), so it can't be restarted
 * automatically. Mounts once at the layout root (main window).
 *
 * Copy is intentionally static (not i18n): this path only fires in
 * developer setups where the server is launched by hand, never in the
 * packaged app where the reference always manages and restarts the server.
 */
export function RestartRequiredToast() {
	const t = useTranslations("errors");
	const current = useRestartNotice((s) => s.current);
	const show = useRestartNotice((s) => s.show);
	const clear = useRestartNotice((s) => s.clear);
	const level = Math.min(useSurface() + 3, 8);

	useEffect(
		() => onServerRestartRequired(({ setting, kind }) => show(setting, kind ?? "unmanaged")),
		[show]
	);

	useEffect(() => {
		if (!current) {
			return;
		}
		const id = window.setTimeout(clear, AUTO_DISMISS_MS);
		return () => window.clearTimeout(id);
	}, [current, clear]);

	if (!current) {
		return null;
	}

	return (
		<output
			aria-live="polite"
			className={cn(
				"fixed right-4 bottom-4 z-toast w-[420px] max-w-[90vw] rounded-md border border-warning/40 p-3 shadow-lg",
				surfaceBg(level)
			)}
		>
			<div className="flex items-start gap-2">
				<HugeiconsIcon
					aria-hidden="true"
					className="mt-0.5 shrink-0 text-warning"
					icon={RefreshIcon}
					size={16}
				/>
				<div className="flex flex-1 flex-col">
					<span className="font-medium text-body text-foreground">
						{current.kind === "skew"
							? t("restartServerSkewTitle")
							: t("restartServerUnmanagedTitle")}
					</span>
					<span className="text-foreground-muted text-sm">
						{current.kind === "skew" ? (
							<>
								{t("restartServerSkewBodyPre")}
								<code className="font-mono">{current.setting}</code>
								{t("restartServerSkewBodyMid")}
								<code className="font-mono">STT_SERVER_DIR</code>
								{t("restartServerSkewBodyPost")}
							</>
						) : (
							<>
								<code className="font-mono">{current.setting}</code>
								{t("restartServerUnmanagedBody")}
							</>
						)}
					</span>
				</div>
				<Button
					aria-label="Dismiss"
					className="rounded p-1 text-foreground-muted hover:bg-surface-tertiary hover:text-foreground"
					onClick={clear}
				>
					<HugeiconsIcon icon={Cancel01Icon} size={12} />
				</Button>
			</div>
		</output>
	);
}

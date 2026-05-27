import { Cancel01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import { onServerRestartRequired } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { useRestartNotice } from "../model/restart-notice-store";

// Longer than the swap toast — this is an instruction the user has to act
// on (restart their server), not just an error to acknowledge.
const AUTO_DISMISS_MS = 15_000;

/**
 * Notice for the dev-only case where a startup-only setting changed but the
 * STT server is user-run (not Electron-managed), so it can't be restarted
 * automatically. Mounts once at the layout root (main window).
 *
 * Copy is intentionally static (not i18n): this path only fires in
 * developer setups where the server is launched by hand, never in the
 * packaged app where Electron always manages and restarts the server.
 */
export function RestartRequiredToast() {
	const current = useRestartNotice((s) => s.current);
	const show = useRestartNotice((s) => s.show);
	const clear = useRestartNotice((s) => s.clear);

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
			className="fixed right-4 bottom-4 z-toast w-[420px] max-w-[90vw] rounded-md border border-warning/40 bg-surface-secondary p-3 shadow-lg"
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
							? "Restart the STT server — it's running an outdated build"
							: "Restart the STT server to apply this change"}
					</span>
					<span className="text-foreground-muted text-sm">
						{current.kind === "skew" ? (
							<>
								The connected STT server is missing{" "}
								<code className="font-mono">{current.setting}</code>, so it's running stale code and
								newer commands will silently fail. Restart your STT server process (or set{" "}
								<code className="font-mono">STT_SERVER_DIR</code> so the app manages it).
							</>
						) : (
							<>
								<code className="font-mono">{current.setting}</code> changed, but the server is
								running externally so it couldn't be restarted automatically. Restart your STT
								server process for it to take effect.
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

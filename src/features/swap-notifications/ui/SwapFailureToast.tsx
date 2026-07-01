import {
	AlertCircleIcon,
	DatabaseLockedIcon,
	FileBlockIcon,
	HardDriveIcon,
	LockIcon,
	MicrochipIcon,
	RefreshIcon,
	WifiDisconnectedIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect } from "react";
import { useTranslations } from "use-intl";
import {
	type ModelSwapFailedCategory,
	onModelSwapFailed,
	sttReloadModel,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { truncate } from "@/shared/lib/truncate";
import { Button } from "@/shared/ui/button";
import {
	ToastDismissButton,
	ToastShell,
	useAutoDismiss,
} from "@/shared/ui/toast";
import { useSwapNotifications } from "../model/swap-notifications-store";

const AUTO_DISMISS_MS = 8000;
const DETAIL_PREVIEW_CHARS = 200;

/**
 * Maps a server-classified swap-failure category to a category-specific
 * icon. ``unknown`` and ``superseded`` fall through to a generic alert
 * — the user-readable message is what carries the actual context.
 */
function categoryIcon(category: ModelSwapFailedCategory): IconSvgElement {
	switch (category) {
		case "network":
			return WifiDisconnectedIcon;
		case "model_not_found":
			return FileBlockIcon;
		case "incompatible_quantization":
			return DatabaseLockedIcon;
		case "model_corrupt":
			return FileBlockIcon;
		case "out_of_memory":
			return MicrochipIcon;
		case "disk_full":
			return HardDriveIcon;
		case "permission_denied":
			return LockIcon;
		default:
			return AlertCircleIcon;
	}
}

/**
 * Transient toast for model-swap failures. Mounts once at the layout
 * root and subscribes to ``onModelSwapFailed`` — every failure surface
 * (network down, model 404, GPU OOM, disk full, etc.) flows through
 * here with a category-specific icon and the server-localised
 * ``reason`` as the headline. The ``detail`` (raw exception string) is
 * shown collapsed for diagnostics.
 *
 * Suppresses ``cancelled`` and ``superseded`` — those are user-driven
 * outcomes, not errors, and the UI's revert path already conveys the
 * state change.
 *
 * Auto-dismisses after 8s (longer than transform toasts because the
 * user typically needs to read the diagnostic message and decide what
 * to do next). The ``Retry`` button re-issues the same swap.
 */
export function SwapFailureToast() {
	const current = useSwapNotifications((s) => s.current);
	const show = useSwapNotifications((s) => s.show);
	const clear = useSwapNotifications((s) => s.clear);
	const t = useTranslations("swapFailure");
	const detailsLevel = Math.min(useSurface() + 4, 8);

	useEffect(() => {
		const offFailed = onModelSwapFailed((payload) => {
			// User-initiated cancellation / supersession isn't an error.
			// The picker revert path already covers the "what changed"
			// communication, so swallow these silently here.
			if (
				payload.category === "cancelled" ||
				payload.category === "superseded"
			) {
				return;
			}
			show({
				kind: payload.kind,
				modelName: payload.name,
				reason: payload.reason,
				category: payload.category,
				detail: payload.detail,
			});
		});
		return () => offFailed();
	}, [show]);

	useAutoDismiss(current, clear, AUTO_DISMISS_MS);

	if (!current) {
		return null;
	}

	const handleRetry = () => {
		sttReloadModel(current.kind, current.modelName);
		clear();
	};

	return (
		<ToastShell
			ariaLive="assertive"
			className="fixed right-4 bottom-4 z-toast w-[420px] max-w-[90vw]"
			role="alert"
			tone="error"
		>
			<div className="mb-1 flex items-start gap-2">
				<HugeiconsIcon
					aria-hidden="true"
					className="mt-0.5 shrink-0 text-error"
					icon={categoryIcon(current.category)}
					size={16}
				/>
				<div className="flex flex-1 flex-col">
					<span className="font-medium text-body text-foreground">
						{t("headline", { model: current.modelName })}
					</span>
					<span className="text-foreground-muted text-sm">
						{current.reason}
					</span>
				</div>
				<ToastDismissButton label={t("dismiss")} onClick={clear} />
			</div>
			{current.detail ? (
				<details className="mt-1 ml-6">
					<summary className="cursor-pointer text-foreground-dim text-xs hover:text-foreground-muted">
						{t("technicalDetails")}
					</summary>
					<div className="mt-1 whitespace-pre-wrap break-words font-mono text-foreground-dim text-xs">
						{truncate(current.detail, DETAIL_PREVIEW_CHARS)}
					</div>
				</details>
			) : null}
			<div className="mt-2 flex justify-end gap-2">
				<Button
					className={cn(
						"flex items-center gap-1 rounded border border-border px-3 py-1 text-foreground-secondary text-xs transition-colors hover:bg-surface-elevated",
						surfaceBg(detailsLevel),
					)}
					onClick={handleRetry}
				>
					<HugeiconsIcon icon={RefreshIcon} size={11} />
					{t("retry")}
				</Button>
			</div>
		</ToastShell>
	);
}

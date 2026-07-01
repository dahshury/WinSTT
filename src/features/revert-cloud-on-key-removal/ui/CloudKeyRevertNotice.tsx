"use client";

import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import { useTranslations } from "use-intl";
import { ToastShell } from "@/shared/ui/toast";
import { clearableProviderLabel } from "../model/cloud-revert-decision";
import { useRevertNoticeStore } from "../model/revert-notice-store";

const AUTO_DISMISS_MS = 8000;

/**
 * Transient confirmation toast surfaced when a removed cloud API key auto-
 * reverted a surface to its local engine (see `useCloudKeyAutoRevert`). Mounted
 * once in `RootLayout` (main window); mirrors `CloudSttErrorToasts` styling but
 * reads-stack from the shared `useRevertNoticeStore` since the hook that pushes
 * notices lives in a different subtree. Auto-dismisses after 8s.
 */
export function CloudKeyRevertNotice() {
	const notices = useRevertNoticeStore((s) => s.notices);
	const dismiss = useRevertNoticeStore((s) => s.dismiss);
	const t = useTranslations("integrations");

	useEffect(() => {
		if (notices.length === 0) {
			return;
		}
		const oldest = notices[0];
		if (!oldest) {
			return;
		}
		const handle = window.setTimeout(() => dismiss(oldest.id), AUTO_DISMISS_MS);
		return () => window.clearTimeout(handle);
	}, [notices, dismiss]);

	if (notices.length === 0) {
		return null;
	}

	return (
		<div className="pointer-events-none fixed right-4 bottom-4 z-toast flex w-[420px] max-w-[90vw] flex-col gap-2">
			{notices.map((notice) => (
				<ToastShell
					ariaLive="polite"
					as="output"
					className="pointer-events-auto block"
					key={notice.id}
					tone="success"
				>
					<div className="flex items-start gap-2">
						<HugeiconsIcon
							aria-hidden="true"
							className="mt-0.5 shrink-0 text-success"
							icon={CheckmarkCircle02Icon}
							size={16}
						/>
						<span className="flex-1 text-body text-foreground">
							{t("revertedToLocal", {
								provider: clearableProviderLabel(notice.provider),
							})}
						</span>
					</div>
				</ToastShell>
			))}
		</div>
	);
}

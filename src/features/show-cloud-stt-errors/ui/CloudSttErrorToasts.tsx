"use client";

import {
	AlertCircleIcon,
	Cancel01Icon,
	KeyboardIcon,
	LockIcon,
	TimeQuarterPassIcon,
	WifiDisconnectedIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcOn, windowOpenSettings } from "@/shared/api/ipc-client";
import type { CloudSttProvider } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";

const AUTO_DISMISS_MS = 8000;

type CloudToastKind =
	| "auth"
	| "network"
	| "key_missing"
	| "rate_limit"
	| "provider_error";

interface CloudToast {
	icon: IconSvgElement;
	id: number;
	kind: CloudToastKind;
	message: string;
	provider: CloudSttProvider;
	retryAfter?: number | undefined;
	withOpenIntegrations: boolean;
}

interface CloudErrorPayload {
	message?: string;
	provider: CloudSttProvider;
	retryAfter?: number;
}

function iconFor(kind: CloudToastKind): IconSvgElement {
	switch (kind) {
		case "auth":
			return LockIcon;
		case "network":
			return WifiDisconnectedIcon;
		case "key_missing":
			return KeyboardIcon;
		case "rate_limit":
			return TimeQuarterPassIcon;
		default:
			return AlertCircleIcon;
	}
}

function providerLabel(provider: CloudSttProvider): string {
	return provider === "openrouter" ? "OpenRouter" : "ElevenLabs";
}

const nextToastId = (() => {
	let n = 0;
	return () => ++n;
})();

/**
 * Mounted once at the root layout. Subscribes to the five cloud-STT error
 * channels broadcast by `electron/ipc/stt-cloud.ts` and surfaces each as
 * a transient toast. Auto-dismisses after 8s; auth + key-missing toasts
 * carry an "Open Integrations" action.
 *
 * Stacks bottom-up so multiple errors during a busy session remain
 * visible. Each provider's most recent error of the same kind replaces
 * the previous one so we don't pile up identical toasts.
 */
export function CloudSttErrorToasts() {
	const [toasts, setToasts] = useState<CloudToast[]>([]);
	const t = useTranslations("integrations");
	const base = useSurface();
	const level = Math.min(base + 3, 8);
	const detailsLevel = Math.min(base + 4, 8);

	useEffect(() => {
		const push = (
			kind: CloudToastKind,
			message: string,
			payload: CloudErrorPayload,
			withOpenIntegrations: boolean,
		) => {
			setToasts((prev) => {
				// Replace any prior toast of the same kind+provider so a stuck
				// loop doesn't spam the corner.
				const filtered = prev.filter(
					(t2) => !(t2.kind === kind && t2.provider === payload.provider),
				);
				return [
					...filtered,
					{
						id: nextToastId(),
						kind,
						provider: payload.provider,
						message,
						retryAfter: payload.retryAfter,
						icon: iconFor(kind),
						withOpenIntegrations,
					},
				];
			});
		};

		const offAuth = ipcOn(IPC.STT_CLOUD_AUTH_FAILED, (data) => {
			const p = data as CloudErrorPayload;
			push(
				"auth",
				t("toastAuthFailed", { provider: providerLabel(p.provider) }),
				p,
				true,
			);
		});
		const offNet = ipcOn(IPC.STT_CLOUD_NETWORK_ERROR, (data) => {
			const p = data as CloudErrorPayload;
			push("network", t("toastNetworkError"), p, false);
		});
		const offMissing = ipcOn(IPC.STT_CLOUD_KEY_MISSING, (data) => {
			const p = data as CloudErrorPayload;
			push(
				"key_missing",
				t("toastKeyMissing", { provider: providerLabel(p.provider) }),
				p,
				true,
			);
		});
		const offRate = ipcOn(IPC.STT_CLOUD_RATE_LIMITED, (data) => {
			const p = data as CloudErrorPayload;
			const head = t("toastRateLimited", {
				provider: providerLabel(p.provider),
			});
			const detail = p.retryAfter
				? ` — ${t("toastRateLimitedRetry", { seconds: Math.round(p.retryAfter) })}`
				: "";
			push("rate_limit", `${head}${detail}`, p, false);
		});
		const offProvider = ipcOn(IPC.STT_CLOUD_PROVIDER_ERROR, (data) => {
			const p = data as CloudErrorPayload;
			push(
				"provider_error",
				t("toastProviderError", {
					provider: providerLabel(p.provider),
					message: p.message ?? "",
				}),
				p,
				false,
			);
		});

		return () => {
			offAuth();
			offNet();
			offMissing();
			offRate();
			offProvider();
		};
	}, [t]);

	useEffect(() => {
		if (toasts.length === 0) {
			return;
		}
		const oldest = toasts[0];
		if (!oldest) {
			return;
		}
		const handle = window.setTimeout(() => {
			setToasts((prev) => prev.filter((entry) => entry.id !== oldest.id));
		}, AUTO_DISMISS_MS);
		return () => window.clearTimeout(handle);
	}, [toasts]);

	if (toasts.length === 0) {
		return null;
	}

	const dismiss = (id: number) =>
		setToasts((prev) => prev.filter((entry) => entry.id !== id));

	return (
		<div className="pointer-events-none fixed right-4 bottom-4 z-toast flex w-[420px] max-w-[90vw] flex-col gap-2">
			{toasts.map((toast) => (
				<div
					aria-live="assertive"
					className={cn(
						"pointer-events-auto rounded-md border border-error/40 p-3 shadow-lg",
						surfaceBg(level),
					)}
					key={toast.id}
					role="alert"
				>
					<div className="flex items-start gap-2">
						<HugeiconsIcon
							aria-hidden="true"
							className="mt-0.5 shrink-0 text-error"
							icon={toast.icon}
							size={16}
						/>
						<div className="flex flex-1 flex-col">
							<span className="text-body text-foreground">{toast.message}</span>
							{toast.withOpenIntegrations ? (
								<div className="mt-2 flex justify-end gap-2">
									<Button
										className={cn(
											"rounded border border-border px-3 py-1 text-foreground-secondary text-xs transition-colors hover:bg-surface-elevated",
											surfaceBg(detailsLevel),
										)}
										onClick={() => {
											windowOpenSettings();
											dismiss(toast.id);
										}}
									>
										{t("openIntegrations")}
									</Button>
								</div>
							) : null}
						</div>
						<Button
							aria-label="Dismiss"
							className="rounded p-1 text-foreground-muted hover:bg-surface-tertiary hover:text-foreground"
							onClick={() => dismiss(toast.id)}
						>
							<HugeiconsIcon icon={Cancel01Icon} size={12} />
						</Button>
					</div>
				</div>
			))}
		</div>
	);
}

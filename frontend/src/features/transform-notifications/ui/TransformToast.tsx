"use client";

import { Cancel01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import { applyTransform, onTransformApplied, onTransformFailed } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import {
	type TransformNotification,
	useTransformNotifications,
} from "../model/transform-notifications-store";

const AUTO_DISMISS_MS = 5000;
const PREVIEW_CHARS = 120;

function truncate(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, max).trimEnd()}…`;
}

function resolveToastBody(notification: TransformNotification): string {
	if (notification.kind === "applied") {
		return notification.after ? truncate(notification.after, PREVIEW_CHARS) : "";
	}
	return notification.reason || "Transform failed";
}

/**
 * Single transient toast for Transforms feedback. Mounts once at the app
 * root via the layout; subscribes to IPC `transforms:applied` /
 * `transforms:failed` events and renders a brief preview with copy / retry
 * actions. Auto-dismisses after 5s; newer events overwrite older ones.
 */
export function TransformToast() {
	const current = useTransformNotifications((s) => s.current);
	const show = useTransformNotifications((s) => s.show);
	const clear = useTransformNotifications((s) => s.clear);

	useEffect(() => {
		const offApplied = onTransformApplied((payload) => {
			// An "applied" event with no selection counts as a no-op signal —
			// surface it as a hint rather than a success.
			if (!(payload.before || payload.after)) {
				show({
					kind: "no-selection",
					transformId: payload.transformId,
					transformName: payload.transformName,
					reason: "No text selected",
				});
				return;
			}
			show({
				kind: "applied",
				transformId: payload.transformId,
				transformName: payload.transformName,
				before: payload.before,
				after: payload.after,
			});
		});
		const offFailed = onTransformFailed((payload) => {
			show({
				kind: "failed",
				transformId: payload.transformId,
				reason: payload.reason,
			});
		});
		return () => {
			offApplied();
			offFailed();
		};
	}, [show]);

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

	const isFailure = current.kind === "failed" || current.kind === "no-selection";
	const headline = current.transformName || current.transformId;
	const body = resolveToastBody(current);

	const handleRetry = () => {
		applyTransform(current.transformId).catch(() => undefined);
	};

	return (
		<div
			aria-live="polite"
			className="fixed right-4 bottom-4 z-[400] w-[360px] max-w-[90vw] rounded-md border border-border bg-surface-secondary p-3 shadow-lg"
			role="status"
		>
			<div className="mb-1 flex items-start gap-2">
				<span
					className={`mt-0.5 inline-block h-2 w-2 rounded-full ${
						isFailure ? "bg-error" : "bg-accent"
					}`}
				/>
				<span className="flex-1 font-medium text-body text-foreground">{headline}</span>
				<Button
					aria-label="Dismiss"
					className="rounded p-1 text-foreground-muted hover:bg-surface-tertiary hover:text-foreground"
					onClick={clear}
				>
					<HugeiconsIcon icon={Cancel01Icon} size={12} />
				</Button>
			</div>
			<div className="whitespace-pre-wrap text-foreground-muted text-sm leading-relaxed">
				{body}
			</div>
			{isFailure ? (
				<div className="mt-2 flex justify-end gap-2">
					<Button
						className="flex items-center gap-1 rounded border border-border bg-surface-tertiary px-3 py-1 text-foreground-secondary text-xs transition-colors hover:bg-surface-elevated"
						onClick={handleRetry}
					>
						<HugeiconsIcon icon={RefreshIcon} size={11} />
						Retry
					</Button>
				</div>
			) : null}
		</div>
	);
}

import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import {
	finalizeListenSession,
	type ListenSessionSnapshot,
	listenSessionSnapshot,
	onListenSessionChangedReady,
} from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { EntryCard } from "@/shared/ui/entry-card-list";
import { Spinner } from "@/shared/ui/spinner";
import { Tooltip } from "@/shared/ui/tooltip";

export interface LiveListenSessionCardViewProps {
	canFinalize: boolean;
	emptyLabel: string;
	finalizeLabel: string;
	finalizing: boolean;
	lines: readonly string[];
	livePreview: string;
	onFinalize: () => void;
	title: string;
}

/**
 * Presentational card for the ongoing listen session at the top of the
 * History table: committed caption lines plus the in-flight preview, with a
 * Finalize action that cuts the session-so-far into its own entry while the
 * session keeps running. Pure view — subscription state lives in the wrapper.
 */
export function LiveListenSessionCardView({
	canFinalize,
	emptyLabel,
	finalizeLabel,
	finalizing,
	lines,
	livePreview,
	onFinalize,
	title,
}: LiveListenSessionCardViewProps): ReactNode {
	const preview = livePreview.trim();
	return (
		<EntryCard
			accent={{ label: title, railClass: "bg-history-stt" }}
			footer={[]}
		>
			<div className="flex items-start gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex items-center gap-2">
						{/* Grayscale live indicator — a soft pulse, not a status color. */}
						<span
							aria-hidden="true"
							className="inline-flex size-2 shrink-0 animate-pulse rounded-full bg-foreground/70"
						/>
						<span className="font-medium text-body-sm text-foreground">
							{title}
						</span>
					</div>
					{lines.length === 0 && preview.length === 0 ? (
						<p className="text-body-sm text-foreground-muted">{emptyLabel}</p>
					) : (
						<div className="flex flex-col gap-0.5">
							{lines.map((line, index) => (
								<p
									className="whitespace-pre-wrap break-words text-body-sm text-foreground"
									dir="auto"
									// Session lines are append-only, so position identifies a
									// line; combined with the text it stays unique.
									key={`${index}:${line}`}
								>
									{line}
								</p>
							))}
							{preview.length > 0 ? (
								<p
									className="whitespace-pre-wrap break-words text-body-sm text-foreground-muted italic"
									dir="auto"
								>
									{preview}
								</p>
							) : null}
						</div>
					)}
				</div>
				<Tooltip content={finalizeLabel}>
					<Button
						className="shrink-0 gap-1.5 px-2 py-1 text-xs"
						disabled={!canFinalize}
						onClick={onFinalize}
					>
						{finalizing ? (
							<Spinner className="size-3.5" />
						) : (
							<HugeiconsIcon icon={Tick02Icon} size={14} />
						)}
						{finalizeLabel}
					</Button>
				</Tooltip>
			</div>
		</EntryCard>
	);
}

/**
 * Subscribes to the backend's authoritative ongoing-session snapshots and
 * renders the live card while one is active. One command snapshot hydrates a
 * newly opened History tab; all subsequent updates are pushed. The finalized
 * entry arrives through the standard history `Added` event, while the session
 * event empties this card as the running session restarts from zero lines.
 *
 * Gated on the recording mode: outside listen mode the card never renders and
 * the subscription is off, so a snapshot that momentarily still reads active (a
 * stop racing a slow start on the backend) can't strand a "Listening now"
 * card after the user has switched away.
 */
export function LiveListenSessionCard(): ReactNode {
	const t = useTranslations("history");
	const isListenMode = useSettingsStore(
		(s) => (s.settings.general?.recordingMode ?? "ptt") === "listen",
	);
	const [snapshot, setSnapshot] = useState<ListenSessionSnapshot | null>(null);
	const [finalizing, setFinalizing] = useState(false);

	useEffect(() => {
		if (!isListenMode) {
			// Drop the last snapshot so re-entering listen mode can't flash the
			// previous session's lines before the initial snapshot lands.
			setSnapshot(null);
			return;
		}
		let cancelled = false;
		let receivedEvent = false;
		let unsubscribe: () => void = () => undefined;
		void (async () => {
			const cleanup = await onListenSessionChangedReady((next) => {
				receivedEvent = true;
				if (!cancelled) {
					setSnapshot(next);
				}
			});
			if (cancelled) {
				cleanup();
				return;
			}
			unsubscribe = cleanup;
			// The native subscription is now installed. If a push wins while the
			// snapshot is in flight, do not let the older response overwrite it.
			const next = await listenSessionSnapshot();
			if (!(cancelled || receivedEvent)) {
				setSnapshot(next);
			}
		})().catch((error) => {
			console.warn("[listen-session] failed to reconcile live session:", error);
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [isListenMode]);

	// The mode check also covers the render between a mode switch and the
	// effect above clearing the stale snapshot.
	if (!(isListenMode && snapshot?.active)) {
		return null;
	}

	const handleFinalize = () => {
		setFinalizing(true);
		finalizeListenSession().finally(() => setFinalizing(false));
	};

	return (
		<LiveListenSessionCardView
			canFinalize={snapshot.lines.length > 0 && !finalizing}
			emptyLabel={t("liveListenEmpty")}
			finalizeLabel={t("liveListenFinalize")}
			finalizing={finalizing}
			lines={snapshot.lines}
			livePreview={snapshot.livePreview}
			onFinalize={handleFinalize}
			title={t("liveListenTitle")}
		/>
	);
}

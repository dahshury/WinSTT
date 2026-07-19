import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
	finalizeListenSession,
	type ListenSessionSnapshot,
	listenSessionSnapshot,
} from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { EntryCard } from "@/shared/ui/entry-card-list";
import { Spinner } from "@/shared/ui/spinner";
import { Tooltip } from "@/shared/ui/tooltip";

/** Poll cadence for the live session snapshot while the History tab is open.
 *  A tiny IPC clone — cheap enough to keep the card feeling live without an
 *  event feed (the settings window has no listen-mode event subscriptions). */
const POLL_MS = 1000;

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
 * Presentational card for the ONGOING listen session at the top of the
 * History table: committed caption lines plus the in-flight preview, with a
 * Finalize action that cuts the session-so-far into its own entry while the
 * session keeps running. Pure view — polling lives in the wrapper below.
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
 * Polls the backend for the ongoing listen session and renders the live card
 * while one is active. The finalized entry arrives through the standard
 * history `Added` event, so the table below refreshes itself; the card
 * empties on the next poll (the running session restarts from zero lines).
 */
export function LiveListenSessionCard(): ReactNode {
	const t = useTranslations("history");
	const [snapshot, setSnapshot] = useState<ListenSessionSnapshot | null>(null);
	const [finalizing, setFinalizing] = useState(false);

	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const poll = async () => {
			const next = await listenSessionSnapshot();
			if (cancelled) {
				return;
			}
			setSnapshot(next);
			timer = setTimeout(() => {
				void poll();
			}, POLL_MS);
		};
		void poll();
		return () => {
			cancelled = true;
			if (timer) {
				clearTimeout(timer);
			}
		};
	}, []);

	if (!snapshot?.active) {
		return null;
	}

	const handleFinalize = () => {
		setFinalizing(true);
		finalizeListenSession()
			.then(async () => {
				// Refresh immediately so the card empties without waiting a tick.
				const next = await listenSessionSnapshot();
				setSnapshot(next);
			})
			.finally(() => setFinalizing(false));
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

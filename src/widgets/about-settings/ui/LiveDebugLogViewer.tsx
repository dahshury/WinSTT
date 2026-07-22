import {
	Copy01Icon,
	Delete02Icon,
	PauseIcon,
	PlayIcon,
	StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { onTyped } from "@/shared/api/native-boundary";
import { NATIVE_EVENTS } from "@/shared/api/native-events";
import { COPY_FEEDBACK_MS, copyToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

const MAX_LINES = 1000;
const FLUSH_DELAY_MS = 250;

interface LiveLogLinePayload {
	level: string;
	message: string;
	target: string;
	timestampMs: number;
}

interface LiveLogLine extends LiveLogLinePayload {
	id: number;
}

type StreamState =
	| { status: "stopped" }
	| { status: "starting" }
	| { status: "live" }
	| { status: "pausing" }
	| { status: "paused" }
	| { status: "stopping" }
	| { status: "error"; message: string };

const INITIAL_STREAM_STATE: StreamState = { status: "stopped" };

const LEVEL_CLASS: Record<string, string> = {
	debug: "text-activity",
	error: "text-error",
	info: "text-success",
	trace: "text-foreground-muted",
	warn: "text-warning",
};

function formatLogTime(timestampMs: number): string {
	const date = new Date(timestampMs);
	const pad = (value: number, size = 2) => String(value).padStart(size, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
		date.getSeconds(),
	)}.${pad(date.getMilliseconds(), 3)}`;
}

function appendCapped<T>(existing: T[], incoming: T[]): T[] {
	const next = existing.concat(incoming);
	return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}

function LogViewerButton({
	children,
	disabled,
	icon,
	onClick,
}: {
	children: ReactNode;
	disabled?: boolean;
	icon: typeof PlayIcon;
	onClick: () => void;
}): ReactNode {
	return (
		<Button
			className="h-8 gap-1.5 rounded-md bg-surface-3 px-2.5 font-medium text-body-sm text-foreground transition-colors hover:bg-surface-4"
			disabled={disabled}
			onClick={onClick}
		>
			<HugeiconsIcon aria-hidden="true" icon={icon} size={13} />
			{children}
		</Button>
	);
}

export function LiveDebugLogViewer(): ReactNode {
	const t = useTranslations("about");
	const [lines, setLines] = useState<LiveLogLine[]>([]);
	const [stream, setStream] = useState<StreamState>(INITIAL_STREAM_STATE);
	const [copied, setCopied] = useState(false);
	const pendingRef = useRef<LiveLogLine[]>([]);
	const nextIdRef = useRef(0);
	const backendEnabledRef = useRef(false);
	const mountedRef = useRef(true);
	const pinnedRef = useRef(true);
	const scrollRef = useRef<HTMLDivElement>(null);
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const scheduleFlush = useCallback(() => {
		if (
			flushTimerRef.current !== undefined ||
			pendingRef.current.length === 0
		) {
			return;
		}

		flushTimerRef.current = setTimeout(() => {
			flushTimerRef.current = undefined;
			if (!backendEnabledRef.current || pendingRef.current.length === 0) {
				return;
			}
			const incoming = pendingRef.current;
			pendingRef.current = [];
			setLines((current) => appendCapped(current, incoming));
		}, FLUSH_DELAY_MS);
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		const unlisten = onTyped<LiveLogLinePayload, LiveLogLinePayload>(
			NATIVE_EVENTS.DIAGNOSTICS_LOG_LINE,
			(payload) => payload,
			(payload) => {
				const pending = pendingRef.current;
				pending.push({ ...payload, id: nextIdRef.current++ });
				if (pending.length > MAX_LINES) {
					pending.splice(0, pending.length - MAX_LINES);
				}
				scheduleFlush();
			},
		);

		return () => {
			mountedRef.current = false;
			unlisten();
			if (copiedTimerRef.current !== undefined) {
				clearTimeout(copiedTimerRef.current);
			}
			if (flushTimerRef.current !== undefined) {
				clearTimeout(flushTimerRef.current);
				flushTimerRef.current = undefined;
			}
			if (backendEnabledRef.current) {
				backendEnabledRef.current = false;
				void commands.diagSetLogStreaming(false);
			}
		};
	}, [scheduleFlush]);

	useEffect(() => {
		if (pinnedRef.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [lines]);

	const setBackendStreaming = async (enabled: boolean): Promise<boolean> => {
		try {
			const result = await commands.diagSetLogStreaming(enabled);
			if (!mountedRef.current) {
				if (enabled && result.status === "ok" && result.data) {
					void commands.diagSetLogStreaming(false);
				}
				return false;
			}
			if (result.status === "error") {
				setStream({ status: "error", message: result.error });
				return false;
			}
			backendEnabledRef.current = result.data;
			if (result.data) {
				scheduleFlush();
			}
			return result.data === enabled;
		} catch {
			if (mountedRef.current) {
				setStream({
					status: "error",
					message: t("liveLogsConnectionError"),
				});
			}
			return false;
		}
	};

	const start = async () => {
		setStream({ status: "starting" });
		if (await setBackendStreaming(true)) {
			setStream({ status: "live" });
		}
	};

	const pauseOrResume = async () => {
		if (stream.status === "live") {
			setStream({ status: "pausing" });
			if (await setBackendStreaming(false)) {
				setStream({ status: "paused" });
			}
			return;
		}
		if (stream.status === "paused") {
			setStream({ status: "starting" });
			if (await setBackendStreaming(true)) {
				setStream({ status: "live" });
			}
		}
	};

	const stop = async () => {
		setStream({ status: "stopping" });
		if (!backendEnabledRef.current || (await setBackendStreaming(false))) {
			setStream({ status: "stopped" });
		}
	};

	const clear = () => {
		if (flushTimerRef.current !== undefined) {
			clearTimeout(flushTimerRef.current);
			flushTimerRef.current = undefined;
		}
		pendingRef.current = [];
		setLines([]);
		pinnedRef.current = true;
	};

	const copy = () => {
		const text = lines
			.map(
				(line) =>
					`${formatLogTime(line.timestampMs)} ${line.level.toUpperCase()} [${line.target}] ${line.message}`,
			)
			.join("\n");
		copyToClipboard(text);
		setCopied(true);
		if (copiedTimerRef.current !== undefined) {
			clearTimeout(copiedTimerRef.current);
		}
		copiedTimerRef.current = setTimeout(
			() => setCopied(false),
			COPY_FEEDBACK_MS,
		);
	};

	const handleScroll = () => {
		const element = scrollRef.current;
		if (!element) {
			return;
		}
		pinnedRef.current =
			element.scrollHeight - element.scrollTop - element.clientHeight < 24;
	};

	const transitioning = ["pausing", "starting", "stopping"].includes(
		stream.status,
	);
	const canPause = stream.status === "live" || stream.status === "paused";
	const canStop = canPause;
	const isLive = stream.status === "live";
	const statusLabel = (() => {
		switch (stream.status) {
			case "live":
				return t("liveLogsStatusLive", { count: lines.length });
			case "paused":
				return t("liveLogsStatusPaused", { count: lines.length });
			case "starting":
				return t("liveLogsStatusStarting");
			case "pausing":
				return t("liveLogsStatusPausing");
			case "stopping":
				return t("liveLogsStatusStopping");
			case "error":
				return stream.message;
			default:
				return t("liveLogsStatusOff", { count: lines.length });
		}
	})();

	return (
		<div className="border-border border-t py-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="font-medium text-body text-foreground leading-tight">
						{t("liveLogsTitle")}
					</span>
					<span className="text-body-sm text-foreground-muted leading-snug">
						{t("liveLogsDescription")}
					</span>
				</div>
				<div className="flex shrink-0 flex-wrap gap-2">
					{stream.status === "stopped" || stream.status === "error" ? (
						<LogViewerButton
							disabled={transitioning}
							icon={PlayIcon}
							onClick={() => void start()}
						>
							{t("liveLogsStart")}
						</LogViewerButton>
					) : (
						<>
							<LogViewerButton
								disabled={!canPause || transitioning}
								icon={isLive ? PauseIcon : PlayIcon}
								onClick={() => void pauseOrResume()}
							>
								{isLive ? t("liveLogsPause") : t("liveLogsResume")}
							</LogViewerButton>
							<LogViewerButton
								disabled={!canStop || transitioning}
								icon={StopIcon}
								onClick={() => void stop()}
							>
								{t("liveLogsStop")}
							</LogViewerButton>
						</>
					)}
					<LogViewerButton
						disabled={lines.length === 0}
						icon={Copy01Icon}
						onClick={copy}
					>
						{copied ? t("liveLogsCopied") : t("liveLogsCopy")}
					</LogViewerButton>
					<LogViewerButton
						disabled={lines.length === 0}
						icon={Delete02Icon}
						onClick={clear}
					>
						{t("liveLogsClear")}
					</LogViewerButton>
				</div>
			</div>

			<div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface-1">
				<div className="flex items-center gap-2 border-divider border-b px-3 py-2 text-body-sm text-foreground-muted">
					<span
						aria-hidden="true"
						className={cn(
							"size-2 rounded-full",
							isLive ? "animate-pulse bg-success" : "bg-foreground-muted/50",
						)}
					/>
					<span aria-live="polite">{statusLabel}</span>
				</div>
				<div
					aria-label={t("liveLogsOutputLabel")}
					className="h-72 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed"
					onScroll={handleScroll}
					ref={scrollRef}
					role="log"
				>
					{lines.length === 0 ? (
						<p className="text-foreground-muted">{t("liveLogsEmpty")}</p>
					) : (
						lines.map((line) => (
							<div className="flex min-w-0 gap-2" key={line.id}>
								<span className="shrink-0 text-foreground-muted tabular-nums">
									{formatLogTime(line.timestampMs)}
								</span>
								<span
									className={cn(
										"w-11 shrink-0 font-semibold uppercase",
										LEVEL_CLASS[line.level] ?? "text-foreground-muted",
									)}
								>
									{line.level}
								</span>
								<span className="min-w-0 whitespace-pre-wrap break-words text-foreground-secondary">
									<span className="text-foreground-muted">[{line.target}]</span>{" "}
									{line.message}
								</span>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
}

import {
	EarIcon,
	ToggleOnIcon,
	TouchInteraction01Icon,
	VoiceIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m,
	type Variants,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { onSettingsChanged, settingsLoad } from "@/shared/api/ipc-client";
import {
	trayIndicatorHide,
	trayIndicatorShow,
} from "@/shared/api/ipc/tray-indicator";
import { decodeSettingsPayload } from "@/shared/config/settings-codec";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import { springs } from "@/shared/lib/springs";
import { GlassPill } from "@/shared/ui/glass-pill";
import {
	iconForPostProcessingProfileId,
	resolveActivePostProcessingPreset,
} from "@/widgets/llm-settings";

type RecordingMode = "ptt" | "toggle" | "listen" | "wakeword";

/** How long the pill dwells on screen after the LAST switch before it exits. The
 *  timer resets on every swap, so rapid cycling keeps one pill alive (its content
 *  just morphs) instead of restarting an enter/exit per swap. */
const DWELL_MS = 1900;

const MODE_ICON: Record<RecordingMode, IconSvgElement> = {
	ptt: TouchInteraction01Icon,
	toggle: ToggleOnIcon,
	listen: EarIcon,
	wakeword: VoiceIcon,
};

const MODE_LABEL_KEY = {
	ptt: "pushToTalk",
	toggle: "toggle",
	listen: "listen",
	wakeword: "wakeWord",
} as const satisfies Record<RecordingMode, string>;

type PillContent =
	| { kind: "mode"; mode: RecordingMode }
	| { kind: "preset"; id: string; name: string };

/** Enter/exit for the whole pill — a bottom-anchored rise + fade on the slow tier,
 *  matching the recording overlay's motion vocabulary. Only plays ONCE per
 *  appearance; content swaps while it's up do not retrigger it. */
const pillVariants: Variants = {
	initial: { opacity: 0, y: 12, scale: 0.94 },
	animate: { opacity: 1, y: 0, scale: 1, transition: springs.slow },
	exit: {
		opacity: 0,
		y: 8,
		scale: 0.97,
		transition: { duration: springs.slow.exit.duration },
	},
};

/** Quick cross-fade for the icon + text when the content morphs in place. */
const contentVariants: Variants = {
	initial: { opacity: 0, y: 3 },
	animate: { opacity: 1, y: 0, transition: springs.fast },
	exit: {
		opacity: 0,
		y: -3,
		transition: { duration: springs.fast.exit.duration },
	},
};

/**
 * Tray-indicator pill window renderer. Watches the `settings:changed` broadcast
 * every window receives and, when the recording mode or the active post-processing
 * preset changes (typically from a global hotkey), briefly shows a frosted-glass
 * pill — the same material as the recording overlay — announcing the new value
 * over the notification-area corner. The backend owns placement, the focus gate,
 * and anti-collision with the recording overlay.
 */
export function TrayIndicatorPage() {
	const tGeneral = useTranslations("general");
	const tStatus = useTranslations("statusBar");
	const setSettings = useSettingsStore((s) => s.setSettings);

	const [content, setContent] = useState<PillContent | null>(null);
	const [active, setActive] = useState(false);

	const initializedRef = useRef(false);
	const prevModeRef = useRef<RecordingMode>("ptt");
	const prevPresetRef = useRef<string>("");
	const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Latest visibility INTENT, tracked synchronously so the exit-complete handler
	// can tell a genuine dismissal from a swap that landed during the exit tween.
	const wantVisibleRef = useRef(false);

	useEffect(() => {
		// Defined inside the effect so they carry no render-fresh identity into the
		// dependency array — the effect subscribes exactly once (setSettings is a
		// stable store action) and these helpers close over refs + stable setters.
		const seed = (settings: AppSettingsOutput) => {
			prevModeRef.current = (settings.general?.recordingMode ??
				"ptt") as RecordingMode;
			prevPresetRef.current =
				resolveActivePostProcessingPreset(settings.llm.dictation)?.id ?? "";
			initializedRef.current = true;
		};

		const reveal = async (next: PillContent) => {
			// Mark "want visible" BEFORE the await so a stale exit-complete that fires
			// during the IPC round-trip re-shows instead of hiding the window.
			wantVisibleRef.current = true;
			// The backend suppresses the pill while the settings window is focused —
			// respect that verdict rather than flashing a hidden window.
			const shown = await trayIndicatorShow();
			if (!shown) {
				wantVisibleRef.current = false;
				return;
			}
			// Swap content in place and keep (or start) the single pill alive; the
			// constant AnimatePresence key means a swap morphs the content instead of
			// restarting an enter/exit, so fast successive switches stay smooth.
			setContent(next);
			setActive(true);
			if (dwellTimerRef.current) {
				clearTimeout(dwellTimerRef.current);
			}
			dwellTimerRef.current = setTimeout(() => {
				wantVisibleRef.current = false;
				setActive(false);
			}, DWELL_MS);
		};

		const handleChange = (settings: AppSettingsOutput) => {
			const mode = (settings.general?.recordingMode ?? "ptt") as RecordingMode;
			const preset = resolveActivePostProcessingPreset(settings.llm.dictation);
			const presetId = preset?.id ?? "";

			// The first payload only establishes a baseline — never a pill.
			if (!initializedRef.current) {
				prevModeRef.current = mode;
				prevPresetRef.current = presetId;
				initializedRef.current = true;
				return;
			}

			let next: PillContent | null = null;
			if (mode !== prevModeRef.current) {
				next = { kind: "mode", mode };
			} else if (presetId !== prevPresetRef.current && preset?.name) {
				next = { kind: "preset", id: preset.id, name: preset.name };
			}
			prevModeRef.current = mode;
			prevPresetRef.current = presetId;

			if (next) {
				void reveal(next);
			}
		};

		let cancelled = false;
		let unsub = () => {
			/* replaced once the async subscription resolves */
		};
		void (async () => {
			try {
				const initial = decodeSettingsPayload(await settingsLoad());
				if (!cancelled) {
					setSettings(initial);
					seed(initial);
				}
			} catch {
				// The first `settings:changed` will establish the baseline instead.
			}
			if (cancelled) {
				return;
			}
			unsub = onSettingsChanged((incoming) => {
				const decoded = decodeSettingsPayload(incoming);
				setSettings(decoded);
				handleChange(decoded);
			});
		})();
		return () => {
			cancelled = true;
			unsub();
			if (dwellTimerRef.current) {
				clearTimeout(dwellTimerRef.current);
			}
		};
	}, [setSettings]);

	const icon =
		content?.kind === "preset"
			? iconForPostProcessingProfileId(content.id)
			: content
				? MODE_ICON[content.mode]
				: MODE_ICON.ptt;
	const caption =
		content?.kind === "preset"
			? tStatus("breakdownPost")
			: tGeneral("recordingMode");
	const value =
		content?.kind === "mode"
			? tGeneral(MODE_LABEL_KEY[content.mode])
			: (content?.name ?? "");
	// Stable identity for the inner cross-fade — same content ⇒ no re-animate.
	const contentKey =
		content?.kind === "preset"
			? `preset:${content.id}`
			: content
				? `mode:${content.mode}`
				: "empty";

	return (
		<LazyMotion features={domAnimation} strict>
			<div className="flex h-screen w-screen items-end justify-end overflow-hidden p-2">
				<AnimatePresence
					onExitComplete={() => {
						// A swap that landed mid-exit already re-armed visibility — keep
						// the window up instead of hiding it out from under the new pill.
						if (wantVisibleRef.current) {
							void trayIndicatorShow();
						} else {
							void trayIndicatorHide();
						}
					}}
				>
					{active && content ? (
						<m.div
							animate="animate"
							exit="exit"
							initial="initial"
							key="tray-pill"
							variants={pillVariants}
						>
							<GlassPill className="max-w-[300px] gap-2.5 py-2 pr-3.5 pl-2.5">
								<span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-3/60 ring-1 ring-overlay-foreground/[0.08] ring-inset">
									<HugeiconsIcon
										aria-hidden="true"
										className="text-overlay-foreground"
										icon={icon}
										size={17}
										strokeWidth={1.8}
									/>
								</span>
								<AnimatePresence initial={false} mode="wait">
									<m.span
										animate="animate"
										className="flex min-w-0 flex-col leading-tight"
										exit="exit"
										initial="initial"
										key={contentKey}
										variants={contentVariants}
									>
										<span className="font-mono text-[9.5px] text-overlay-foreground/55 uppercase tracking-[0.09em]">
											{caption}
										</span>
										<span className="truncate font-medium text-overlay-foreground text-sm tracking-tight">
											{value}
										</span>
									</m.span>
								</AnimatePresence>
							</GlassPill>
						</m.div>
					) : null}
				</AnimatePresence>
			</div>
		</LazyMotion>
	);
}

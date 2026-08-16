import { PlayIcon, StopCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m as motion,
} from "motion/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { cn } from "@/shared/lib/cn";
import { springs } from "@/shared/lib/springs";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupContent,
	InputGroupText,
} from "@/shared/ui/input-group";
import {
	type ForbiddenCombo,
	findConflict,
	formatCombo,
	resolveDisplayText,
} from "../lib/hotkey-recorder-helpers";
import { useKeyRecorder } from "../model/use-key-recorder";

export interface HotkeyRecorderProps {
	currentKey: string;
	/** Backend binding id. When present, the recorder claims the candidate with
	 * the OS before the parent persists it and surfaces any registration failure
	 * inline. */
	hotkeyId?: string;
	/**
	 * Combos this recorder must NOT collide with. A recording that ends up equal
	 * to, a subset of, or a superset of any entry here is rejected: the parent
	 * `onKeyRecorded` is never called and an inline error is shown identifying
	 * the conflicting binding by its `label`. Empty / undefined disables the
	 * cross-hotkey check (single-recorder usages still work unchanged).
	 */
	forbiddenCombos?: readonly ForbiddenCombo[];
	onKeyRecorded: (key: string) => void;
}

const CHIP_BASE =
	"inline-flex h-6 items-center rounded-[6px] px-1.5 py-px text-[11px] leading-none font-medium";
const CHIP_RECORDING = "bg-error/15 text-error ring-1 ring-error/35";
const CHIP_HINT =
	"bg-transparent text-foreground-muted ring-0 italic font-normal";
// Decorative, aria-hidden separator glyph between key chips — a visual symbol,
// not translatable copy. Held in a constant so it isn't flagged as user-facing.
const PLUS_GLYPH = "＋";

function ComboParts({
	text,
	recording,
	isHint,
}: {
	text: string;
	recording: boolean;
	isHint: boolean;
}) {
	// Idle keycaps lift one step above the input-group's substrate so each cap
	// reads as its own surface (the surfaces concept) instead of the recessed,
	// hard-coded `bg-surface-1` it used to use. ComboParts renders inside the
	// group's SurfaceProvider, so useSurface() resolves to the group's level.
	// Called before the `isHint` early return to keep the hook unconditional.
	const chipIdle = cn(
		surfaceBg(Math.min(useSurface() + 1, 8)),
		"text-foreground ring-1 ring-divider",
	);
	if (isHint) {
		return (
			<motion.span
				animate={{ opacity: 1, y: 0 }}
				className={`${CHIP_BASE} ${CHIP_HINT}`}
				initial={{ opacity: 0, y: 2 }}
				key="hint"
				transition={springs.moderate}
			>
				{text}
			</motion.span>
		);
	}
	const parts = text.split(" + ");
	const chipClass = recording ? CHIP_RECORDING : chipIdle;
	return (
		<motion.span
			className="flex items-center gap-1.5"
			layout
			transition={springs.moderate}
		>
			<AnimatePresence initial={false} mode="popLayout">
				{parts.map((part, i) => (
					<motion.span
						animate={{ opacity: 1, y: 0, scale: 1 }}
						className="flex items-center gap-1.5"
						exit={{ opacity: 0, y: -4, scale: 0.92 }}
						initial={{ opacity: 0, y: 4, scale: 0.92 }}
						key={`${part}-${i.toString()}`}
						layout
						transition={springs.fast}
					>
						{i > 0 && (
							<span
								aria-hidden
								className="select-none text-[10px] text-foreground-dim"
							>
								{PLUS_GLYPH}
							</span>
						)}
						<span className={`${CHIP_BASE} ${chipClass}`}>{part}</span>
					</motion.span>
				))}
			</AnimatePresence>
		</motion.span>
	);
}

function RecordingBadge({ label }: { label: string }) {
	return (
		<motion.div
			// react-doctor-disable-next-line react-doctor/no-layout-property-animation -- 0→auto width reveal inside AnimatePresence: the rule's documented FP for the intended enter/exit reveal, and a transform-only swap would clip the badge rather than expand it.
			animate={{ opacity: 1, x: 0, width: "auto" }}
			className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap"
			// react-doctor-disable-next-line react-doctor/no-layout-property-animation -- collapse-to-0 width on exit for the same AnimatePresence reveal; not a per-frame layout animation to eliminate.
			exit={{ opacity: 0, x: 8, width: 0 }}
			// react-doctor-disable-next-line react-doctor/no-layout-property-animation -- initial 0 width for the AnimatePresence enter reveal, paired with the animate→auto target above.
			initial={{ opacity: 0, x: 8, width: 0 }}
			key="recording-badge"
			transition={{
				...springs.moderate,
				opacity: { duration: springs.moderate.exit.duration },
			}}
		>
			<motion.span
				animate={{ opacity: [0.55, 1, 0.55], scale: [0.9, 1.1, 0.9] }}
				className="inline-block size-1.5 rounded-full bg-error"
				transition={{
					duration: 1.1,
					repeat: Number.POSITIVE_INFINITY,
					ease: "easeInOut",
				}}
			/>
			<InputGroupText className="text-error">{label}</InputGroupText>
		</motion.div>
	);
}

function ToggleIcon({ recording }: { recording: boolean }) {
	return (
		<AnimatePresence initial={false} mode="wait">
			<motion.span
				animate={{ opacity: 1, scale: 1, rotate: 0 }}
				className="inline-flex"
				exit={{ opacity: 0, scale: 0.6, rotate: recording ? -25 : 25 }}
				initial={{ opacity: 0, scale: 0.6, rotate: recording ? 25 : -25 }}
				key={recording ? "stop" : "play"}
				transition={springs.fast}
			>
				<HugeiconsIcon
					className="shrink-0"
					icon={recording ? StopCircleIcon : PlayIcon}
					size={16}
					strokeWidth={2.25}
				/>
			</motion.span>
		</AnimatePresence>
	);
}

function ConflictMessage({ message }: { message: string }) {
	// Inline below the recorder card — matches the user's "no toast" preference.
	// `role="alert"` so screen readers announce the rejection on next-tick paint,
	// which is what assistive-tech users expect for "your last action failed".
	return (
		<motion.div
			animate={{ opacity: 1, y: 0 }}
			className="mt-1 text-[11px] text-error"
			exit={{ opacity: 0, y: -2 }}
			initial={{ opacity: 0, y: -2 }}
			key="conflict"
			role="alert"
			transition={springs.moderate}
		>
			{message}
		</motion.div>
	);
}

export function HotkeyRecorder({
	currentKey,
	onKeyRecorded,
	forbiddenCombos,
	hotkeyId,
}: HotkeyRecorderProps) {
	const t = useTranslations("hotkey");
	const [conflictMessage, setConflictMessage] = useState<string | null>(null);

	// Intercept the raw recording-done event so we can reject a conflicting
	// combo BEFORE telling the parent to persist it. The recorder hook still
	// drives all the keyboard state — we only gate the final commit.
	const handleRecorded = (combo: string): void => {
		const conflict = findConflict(combo, forbiddenCombos);
		if (conflict) {
			setConflictMessage(
				t("conflictError", {
					other: conflict.label,
					combo: formatCombo(conflict.combo),
				}),
			);
			return;
		}
		if (hotkeyId) {
			void commands
				.changeBinding(hotkeyId, combo)
				.then((result) => {
					if (result.status === "error") {
						setConflictMessage(result.error);
						return;
					}
					if (!result.data.success) {
						setConflictMessage(result.data.error ?? combo);
						return;
					}
					setConflictMessage(null);
					onKeyRecorded(combo);
				})
				.catch((error: unknown) => {
					setConflictMessage(
						error instanceof Error ? error.message : String(error),
					);
				});
			return;
		}
		setConflictMessage(null);
		onKeyRecorded(combo);
	};

	const { recording, liveKeys, startRecording, stopRecording } = useKeyRecorder(
		{
			onKeyRecorded: handleRecorded,
		},
	);

	const displayText = resolveDisplayText(
		recording,
		liveKeys,
		currentKey,
		t("pressKeys"),
	);
	const isHint = recording && liveKeys.length === 0;
	const onToggle = recording
		? stopRecording
		: () => {
				// Clearing the error on a fresh attempt prevents stale "conflicts with
				// X" text from outliving the next successful recording.
				setConflictMessage(null);
				startRecording();
			};
	const showError = !recording && conflictMessage !== null;
	const tone = recording || showError ? "danger" : "default";
	const toggleLabel = recording ? t("stop") : t("record");

	return (
		<LazyMotion features={domAnimation} strict>
			<div className="w-full min-w-[260px] max-w-[420px]">
				<InputGroup tone={tone}>
					<InputGroupContent>
						<ComboParts
							isHint={isHint}
							recording={recording}
							text={displayText}
						/>
					</InputGroupContent>

					<InputGroupAddon align="inline-end">
						<AnimatePresence initial={false}>
							{recording && (
								<RecordingBadge key="badge" label={t("recording")} />
							)}
						</AnimatePresence>
						<motion.span
							className="inline-flex"
							transition={springs.fast}
							whileHover={{ scale: 1.06 }}
							whileTap={{ scale: 0.92 }}
						>
							<InputGroupButton
								aria-label={toggleLabel}
								onClick={onToggle}
								// Idle stays transparent so the shortcuts rows don't show a
								// repeated column of filled play disks. Recording keeps the red
								// active tone, matching the rest of the recording state.
								tone={recording ? "danger" : "ghost"}
							>
								<ToggleIcon recording={recording} />
							</InputGroupButton>
						</motion.span>
					</InputGroupAddon>
				</InputGroup>
				{/* Bare conditional (no AnimatePresence) so the alert unmounts
				    instantly when the user starts a new recording — keeps the
				    DOM in sync with state without waiting on an exit animation. */}
				{showError && <ConflictMessage message={conflictMessage} />}
			</div>
		</LazyMotion>
	);
}

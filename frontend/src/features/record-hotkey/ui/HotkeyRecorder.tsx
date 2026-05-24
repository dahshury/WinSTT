import { PlayIcon, StopCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, domAnimation, LazyMotion, m as motion } from "motion/react";
import { useTranslations } from "next-intl";
import { formatKeyName } from "@/shared/lib/format-key-name";
import { springs } from "@/shared/lib/springs";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupContent,
	InputGroupText,
} from "@/shared/ui/input-group";
import { useKeyRecorder } from "../model/use-key-recorder";

export interface HotkeyRecorderProps {
	currentKey: string;
	onKeyRecorded: (key: string) => void;
}

export function formatCombo(combo: string): string {
	return combo.split("+").map(formatKeyName).join(" + ");
}

/**
 * Resolves the text shown in the hotkey display box.
 * Extracted as a pure function for testability.
 */
export function resolveDisplayText(
	recording: boolean,
	liveKeys: string[],
	currentKey: string,
	pressKeysLabel: string
): string {
	if (!recording) {
		return formatCombo(currentKey);
	}
	if (liveKeys.length > 0) {
		return liveKeys.map(formatKeyName).join(" + ");
	}
	return pressKeysLabel;
}

const CHIP_BASE =
	"inline-flex h-6 items-center rounded-[6px] px-1.5 py-px text-[11px] leading-none font-medium shadow-[inset_0_1px_0_0_oklch(100%_0_0/0.06),inset_0_0_0_1px_oklch(100%_0_0/0.04)]";
const CHIP_IDLE = "bg-surface-1/70 text-foreground ring-1 ring-divider/70";
const CHIP_RECORDING = "bg-error/15 text-error ring-1 ring-error/35";
const CHIP_HINT = "bg-transparent text-foreground-muted ring-0 italic font-normal";

function ComboParts({
	text,
	recording,
	isHint,
}: {
	text: string;
	recording: boolean;
	isHint: boolean;
}) {
	if (isHint) {
		return (
			<motion.span
				animate={{ opacity: 1, y: 0 }}
				className={`${CHIP_BASE} ${CHIP_HINT}`}
				initial={{ opacity: 0, y: 2 }}
				key="hint"
				transition={{ duration: 0.18, ease: "easeOut" }}
			>
				{text}
			</motion.span>
		);
	}
	const parts = text.split(" + ");
	const chipClass = recording ? CHIP_RECORDING : CHIP_IDLE;
	return (
		<motion.span className="flex items-center gap-1.5" layout transition={springs.moderate}>
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
							<span aria-hidden className="select-none text-[10px] text-foreground-dim">
								＋
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
			animate={{ opacity: 1, x: 0, width: "auto" }}
			className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap"
			exit={{ opacity: 0, x: 8, width: 0 }}
			initial={{ opacity: 0, x: 8, width: 0 }}
			key="recording-badge"
			transition={{ ...springs.moderate, opacity: { duration: 0.12 } }}
		>
			<motion.span
				animate={{ opacity: [0.55, 1, 0.55], scale: [0.9, 1.1, 0.9] }}
				className="inline-block size-1.5 rounded-full bg-error shadow-[0_0_8px_2px_oklch(59%_0.22_25/0.55)]"
				transition={{ duration: 1.1, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
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

export function HotkeyRecorder({ currentKey, onKeyRecorded }: HotkeyRecorderProps) {
	const { recording, liveKeys, startRecording, stopRecording } = useKeyRecorder({
		onKeyRecorded,
	});
	const t = useTranslations("hotkey");
	const displayText = resolveDisplayText(recording, liveKeys, currentKey, t("pressKeys"));
	const isHint = recording && liveKeys.length === 0;
	const onToggle = recording ? stopRecording : startRecording;
	const tone = recording ? "danger" : "default";
	const toggleLabel = recording ? t("stop") : t("record");

	return (
		<LazyMotion features={domAnimation} strict>
			<div className="w-full min-w-[260px] max-w-[420px]">
				<InputGroup tone={tone}>
					<InputGroupContent>
						<ComboParts isHint={isHint} recording={recording} text={displayText} />
					</InputGroupContent>

					<InputGroupAddon align="inline-end">
						<AnimatePresence initial={false}>
							{recording && <RecordingBadge key="badge" label={t("recording")} />}
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
								tone={recording ? "danger" : "default"}
							>
								<ToggleIcon recording={recording} />
							</InputGroupButton>
						</motion.span>
					</InputGroupAddon>
				</InputGroup>
			</div>
		</LazyMotion>
	);
}

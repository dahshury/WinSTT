import { PlayIcon, StopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { useTranslations } from "use-intl";
import { ttsCancel } from "@/shared/api/ipc-client";
import { IconButton } from "@/shared/ui/icon-button";
import { Spinner } from "@/shared/ui/spinner";

export interface TtsPreviewButtonProps {
	activeRequestId: string | null;
	compact: boolean;
	isLoading: boolean;
	isSpeaking: boolean;
	langForVoice: (voiceId: string) => string;
	previewVoice: (voiceId: string, lang: string) => void;
	previewVoiceId: string | null;
	t: ReturnType<typeof useTranslations>;
	targetVoiceId: string;
}

// Builds the play / loading / stop control for one voice. Used both as the
// per-row button in the dropdown and as the in-trigger control for the
// selected voice (closed state). Playback state is global, so only the row
// matching `previewVoiceId` shows stop/spinner — every other row stays a
// plain play button. `compact` shrinks it to fit a list row.
export function TtsPreviewButton({
	activeRequestId,
	compact,
	isLoading,
	isSpeaking,
	langForVoice,
	previewVoice,
	previewVoiceId,
	t,
	targetVoiceId,
}: TtsPreviewButtonProps) {
	const active = previewVoiceId === targetVoiceId;
	const thisLoading = active && isLoading;
	const thisSpeaking = active && isSpeaking;
	let label = t("previewVoice");
	if (thisSpeaking) {
		label = t("stopSpeaking");
	} else if (thisLoading) {
		label = t("loadingVoice");
	}
	const icon = thisLoading ? (
		<Spinner className="size-4" />
	) : (
		<HugeiconsIcon icon={thisSpeaking ? StopIcon : PlayIcon} size={compact ? 14 : 16} />
	);
	const onClick = () => {
		if (thisSpeaking) {
			if (activeRequestId) {
				ttsCancel(activeRequestId);
			}
			return;
		}
		if (thisLoading) {
			return;
		}
		previewVoice(targetVoiceId, langForVoice(targetVoiceId));
	};
	return (
		<IconButton
			aria-label={label}
			className={compact ? "size-6" : undefined}
			disabled={thisLoading}
			icon={icon}
			onClick={onClick}
			tooltip={label}
		/>
	);
}

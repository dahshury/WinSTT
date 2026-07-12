import {
	ComputerIcon,
	PauseIcon,
	PlayIcon,
	Speaker01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import type { SelectOption } from "@/shared/ui/select";
import { Tooltip } from "@/shared/ui/tooltip";

interface OutputDevicePreviewButtonProps {
	/** Whether this device is the currently-selected output device. */
	active: boolean;
	deviceLabel: string;
	isPlaying: boolean;
	onToggle: () => void;
	playLabel: string;
	stopLabel: string;
}

/**
 * Small play/stop button that previews a test sound on a specific output device.
 * Rendered as the trailing element of an output-device row (Settings Output tab
 * and the detached footer output-device picker) so the user can hear which
 * physical speaker each entry routes to before committing.
 */
function OutputDevicePreviewButton({
	active,
	deviceLabel,
	isPlaying,
	onToggle,
	playLabel,
	stopLabel,
}: OutputDevicePreviewButtonProps): ReactNode {
	const label = `${isPlaying ? stopLabel : playLabel}: ${deviceLabel}`;
	return (
		<Tooltip content={isPlaying ? stopLabel : playLabel}>
			<Button
				aria-label={label}
				className={cn(
					"flex size-6 shrink-0 items-center justify-center rounded-full transition-colors duration-150 active:scale-95",
					isPlaying
						? "bg-foreground/15 text-foreground hover:bg-foreground/25"
						: "bg-transparent text-foreground-muted hover:bg-foreground/10 hover:text-foreground",
					active && !isPlaying && "text-foreground-secondary",
				)}
				onClick={() => onToggle()}
			>
				<HugeiconsIcon icon={isPlaying ? PauseIcon : PlayIcon} size={13} />
			</Button>
		</Tooltip>
	);
}

/** Stable preview id for a sound routed to a given output device sink. */
function outputPreviewId(deviceId: string): string {
	return `output:${deviceId || "default"}`;
}

interface BuildOutputDeviceOptionsParams {
	/** Devices to render; `isDefault` picks the icon (computer vs speaker). */
	entries: readonly { id: string; isDefault: boolean; label: string }[];
	/** Currently-selected device id (highlights the active preview button). */
	currentId: string;
	/** `useSoundPreview().playingId`. */
	playingId: string | null;
	/** Sound clip to preview (recording-sound path; `""` = built-in default). */
	soundPath: string;
	/** `useSoundPreview().toggle`. */
	toggle: (
		previewId: string,
		soundPath: string,
		deviceId: string,
	) => Promise<void>;
	playLabel: string;
	stopLabel: string;
}

/**
 * Map output-device entries to `SelectOption[]` carrying a trailing
 * play/preview button, shared by the Settings Output-tab `Select` and the
 * detached footer output-device picker so both render identical rows.
 */
export function buildOutputDeviceOptions({
	entries,
	currentId,
	playingId,
	soundPath,
	toggle,
	playLabel,
	stopLabel,
}: BuildOutputDeviceOptionsParams): SelectOption[] {
	return entries.map((entry) => ({
		id: entry.id,
		label: entry.label,
		icon: entry.isDefault ? ComputerIcon : Speaker01Icon,
		trailing: (
			<OutputDevicePreviewButton
				active={currentId === entry.id}
				deviceLabel={entry.label}
				isPlaying={playingId === outputPreviewId(entry.id)}
				onToggle={() => {
					void toggle(outputPreviewId(entry.id), soundPath, entry.id);
				}}
				playLabel={playLabel}
				stopLabel={stopLabel}
			/>
		),
	}));
}

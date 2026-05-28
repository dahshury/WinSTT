import { type DragEvent, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { AudioVisualizer } from "@/features/audio-visualizer";
import { useFileTranscriptionStore } from "@/features/file-transcription";
import { Elevated, surfaceBg90, useSurface } from "@/shared/lib/surface";
import {
	getContainerClassName,
	runTranscription,
	validateDroppedFile,
} from "../lib/audio-display-test-helpers";
import { FileOverlay } from "./FileOverlay";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { TranscriptionThinking } from "./TranscriptionThinking";

/**
 * Opacity applied to the main-window visualizer while dictation text is on
 * screen. The bright bars otherwise wash out the subtitle text rendered on top
 * of them; dropping to a faint background keeps the visualizer present but
 * well out of the way of text. (The pill is a separate overlay window and is
 * unaffected.)
 */
const VISUALIZER_DIMMED_OPACITY = 0.2;

function DropZoneOverlay({ visible, label }: { visible: boolean; label: string }) {
	const substrate = useSurface();
	if (!visible) {
		return null;
	}
	return (
		<div
			className={`absolute inset-0 z-overlay flex items-center justify-center border-2 border-accent border-dashed ${surfaceBg90(substrate)}`}
		>
			<p className="font-medium text-accent text-sm">{label}</p>
		</div>
	);
}

export function AudioDisplay() {
	const isListenMode = useSettingsStore((s) => s.settings.general?.recordingMode) === "listen";
	const setProcessing = useFileTranscriptionStore((s) => s.setProcessing);
	const setError = useFileTranscriptionStore((s) => s.setError);
	const t = useTranslations("audioDisplay");
	const tf = useTranslations("fileOverlay");

	// Dim the visualizer whenever dictation text is being shown in the main
	// window: live realtime text being written, or finalized sentences from the
	// active recording session. Once the session ends and the text clears, the
	// visualizer returns to full brightness (its idle "hero" state).
	const liveText = useTranscriptionStore((s) => s.currentRealtime);
	const isRecordingActive = useTranscriptionStore((s) => s.isRecordingActive);
	const hasFinalText = useTranscriptionStore((s) => s.items.length > 0);
	const dimVisualizer = liveText.length > 0 || (isRecordingActive && hasFinalText);

	const [isDragOver, setIsDragOver] = useState(false);
	const dragCounter = useRef(0);

	const handleDragEnter = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter.current++;
		if (e.dataTransfer.types.includes("Files")) {
			setIsDragOver(true);
		}
	};

	const handleDragOver = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = "copy";
	};

	const handleDragLeave = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter.current--;
		if (dragCounter.current <= 0) {
			dragCounter.current = 0;
			setIsDragOver(false);
		}
	};

	const handleDrop = async (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter.current = 0;
		setIsDragOver(false);

		const file = Array.from(e.dataTransfer.files)[0];
		const result = validateDroppedFile(file, tf);
		if (!result.ok) {
			if (result.errorMessage && result.fileName) {
				setError(result.fileName, result.errorMessage);
			}
			return;
		}
		await runTranscription(result.fileName as string, result.filePath as string, {
			setProcessing,
			setError,
			tf,
		});
	};

	return (
		<Elevated
			aria-label={t("ariaLabel")}
			className={getContainerClassName(isListenMode)}
			offset={2}
			onDragEnter={handleDragEnter}
			onDragLeave={handleDragLeave}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
			role="region"
		>
			<div
				className="absolute inset-0 flex items-center justify-center"
				style={{
					opacity: dimVisualizer ? VISUALIZER_DIMMED_OPACITY : 1,
					transition: "opacity 300ms ease-out",
				}}
			>
				<AudioVisualizer size="auto" />
			</div>

			<DropZoneOverlay label={t("dropToTranscribe")} visible={isDragOver} />

			<FileOverlay />
			<SubtitleOverlay />
			<TranscriptionThinking />
		</Elevated>
	);
}

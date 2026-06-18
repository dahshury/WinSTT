import { type DragEvent, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { useTranscriptionStore } from "@/entities/transcription";
import { AudioVisualizer } from "@/features/audio-visualizer";
import { useFileTranscriptionStore } from "@/features/file-transcription";
import {
	FILE_DRAG_DROP_EVENT,
	fileDragDropPayloadFromEvent,
} from "@/shared/api/file-drag-drop";
import { Elevated, surfaceBg90, useSurface } from "@/shared/lib/surface";
import {
	collectDroppedFilePaths,
	enqueueDroppedFilePaths,
	enqueueDroppedFiles,
	getContainerClassName,
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

function handleDragOver(e: DragEvent): void {
	e.preventDefault();
	e.stopPropagation();
	e.dataTransfer.dropEffect = "copy";
}

function DropZoneOverlay({
	visible,
	label,
}: {
	visible: boolean;
	label: string;
}) {
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

interface AudioDisplayProps {
	listenSurfaceActive?: boolean;
}

export function AudioDisplay({
	listenSurfaceActive = false,
}: AudioDisplayProps) {
	const t = useTranslations("audioDisplay");

	// Dim the visualizer whenever dictation text is being shown in the main
	// window: live realtime text being written, or finalized sentences from the
	// active recording session. Once the session ends and the text clears, the
	// visualizer returns to full brightness (its idle "hero" state).
	const liveText = useTranscriptionStore((s) => s.currentRealtime);
	const isRecordingActive = useTranscriptionStore((s) => s.isRecordingActive);
	const hasFinalText = useTranscriptionStore((s) => s.items.length > 0);
	const dimVisualizer =
		liveText.length > 0 || (isRecordingActive && hasFinalText);

	// Drives the page-slide: cross-fade to the queue while it has files, back to
	// the visualizer when it drains (FileOverlay lingers its rows for the fade).
	const queueVisible = useFileTranscriptionStore((s) => s.items.length > 0);

	const [isDragOver, setIsDragOver] = useState(false);
	const dragCounter = useRef(0);
	const lastNativeDropAt = useRef(0);

	useEffect(() => {
		const handleNativeDragDrop = (event: Event) => {
			const payload = fileDragDropPayloadFromEvent(event);
			if (payload === null) {
				return;
			}
			if (payload.type === "enter" || payload.type === "over") {
				if (collectDroppedFilePaths(payload.paths).length > 0) {
					setIsDragOver(true);
				}
				return;
			}
			dragCounter.current = 0;
			setIsDragOver(false);
			if (payload.type === "drop") {
				lastNativeDropAt.current = Date.now();
				enqueueDroppedFilePaths(payload.paths).catch(() => {
					/* surfaced as queue rows */
				});
			}
		};

		window.addEventListener(FILE_DRAG_DROP_EVENT, handleNativeDragDrop);
		return () =>
			window.removeEventListener(FILE_DRAG_DROP_EVENT, handleNativeDragDrop);
	}, []);

	const handleDragEnter = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter.current++;
		if (e.dataTransfer.types.includes("Files")) {
			setIsDragOver(true);
		}
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

	const handleDrop = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter.current = 0;
		setIsDragOver(false);
		if (Date.now() - lastNativeDropAt.current < 500) {
			return;
		}
		// Multi-file: append every transcribable file to the queue. Repeated
		// drops accumulate — the main process never clears on a new drop.
		// Enqueue errors surface as error rows from the main process.
		enqueueDroppedFiles(Array.from(e.dataTransfer.files)).catch(() => {
			/* surfaced as queue rows */
		});
	};

	return (
		<Elevated
			aria-label={t("ariaLabel")}
			className={getContainerClassName(listenSurfaceActive)}
			offset={2}
			onDragEnter={handleDragEnter}
			onDragLeave={handleDragLeave}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
			role="region"
		>
			<div className="t-page-slide" data-page={queueVisible ? "2" : "1"}>
				{/* Page 1 — idle visualizer */}
				<div className="t-page" data-page-id="1">
					<div
						className="absolute inset-0 flex items-center justify-center"
						style={{
							opacity: dimVisualizer ? VISUALIZER_DIMMED_OPACITY : 1,
							transition: "opacity 300ms ease-out",
						}}
					>
						<AudioVisualizer size="auto" />
					</div>
				</div>
				{/* Page 2 — file-transcription queue */}
				<div className="t-page" data-page-id="2">
					<FileOverlay />
				</div>
			</div>

			{/* Top-level overlays — above whichever page is active. */}
			<DropZoneOverlay label={t("dropToTranscribe")} visible={isDragOver} />
			<SubtitleOverlay />
			<TranscriptionThinking />
		</Elevated>
	);
}

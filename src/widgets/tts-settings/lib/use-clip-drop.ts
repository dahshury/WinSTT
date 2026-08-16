import { type DragEvent, useState } from "react";
import { getFilePath } from "@/shared/api/ipc-client";
import type { TranslateFn } from "@/shared/i18n/translation-types";
import { hasCloneClipExtension, MAX_VOICE_CLIPS } from "./clone-voice";

interface UseClipDropOptions {
	/** Adopt the dropped files. Receives the native absolute paths (Tauri
	 *  captures them on the drag-enter/drop event; DOM `File`s alone have none).
	 *  Never called with an empty array. */
	onPick: (paths: string[]) => void;
	t: TranslateFn;
}

interface UseClipDropReturn {
	dragOver: boolean;
	dropError: string;
	handlers: {
		onDragLeave: () => void;
		onDragOver: (e: DragEvent<HTMLElement>) => void;
		onDrop: (e: DragEvent<HTMLElement>) => void;
	};
	resetError: () => void;
}

/**
 * Drag-and-drop acceptance for cloning reference clips, modelled on
 * `features/recording-sound/lib/use-sound-drop`.
 *
 * Deliberately NOT decoding the files here: the backend's `tts_build_reference`
 * already decodes every supported container, resamples, trims to the model's cap
 * and reports what it did — duplicating that in an `AudioContext` would decode
 * each file twice and invent a second, drifting definition of "too long". The
 * only client-side checks are the container extension and the part count, so an
 * obviously wrong drop (a PDF, or a whole folder of forty takes) is refused
 * instantly instead of round-tripping to the engine.
 *
 * A voice can be built from SEVERAL clips, so one drop yields the whole
 * selection. Unsupported files are filtered out rather than failing the drop:
 * dragging a folder's worth of mixed content should still take the audio in it.
 */
export function useClipDrop({
	onPick,
	t,
}: UseClipDropOptions): UseClipDropReturn {
	const [dragOver, setDragOver] = useState(false);
	const [dropError, setDropError] = useState("");

	const handleDrop = (e: DragEvent<HTMLElement>) => {
		e.preventDefault();
		setDragOver(false);
		setDropError("");
		const files = Array.from(e.dataTransfer.files);
		if (files.length === 0) {
			return;
		}
		const supported = files.filter((file) => hasCloneClipExtension(file.name));
		if (supported.length === 0) {
			setDropError(t("cloneClipUnsupported"));
			return;
		}
		if (supported.length > MAX_VOICE_CLIPS) {
			setDropError(t("voiceTooManyClips", { count: MAX_VOICE_CLIPS }));
			return;
		}
		const paths = supported
			.map((file) => getFilePath(file))
			.filter((path) => path.length > 0);
		if (paths.length === 0) {
			setDropError(t("cloneClipUnreadable"));
			return;
		}
		// A partial read still adopts what it can — losing one file of a batch must
		// not cost the user the other nine — but it says so, because a clip that
		// silently never arrived is worse than a slow one.
		if (paths.length < supported.length) {
			setDropError(t("cloneClipUnreadable"));
		}
		onPick(paths);
	};

	return {
		dragOver,
		dropError,
		handlers: {
			onDrop: handleDrop,
			onDragOver: (e) => {
				e.preventDefault();
				setDragOver(true);
			},
			onDragLeave: () => setDragOver(false),
		},
		resetError: () => setDropError(""),
	};
}

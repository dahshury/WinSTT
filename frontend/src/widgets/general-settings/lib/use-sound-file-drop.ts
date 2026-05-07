"use client";

import type { DragEvent } from "react";
import { useCallback, useState } from "react";
import { dialogOpenFile, getFilePath } from "@/shared/api/ipc-client";

const ACCEPTED_EXTENSIONS = ["wav", "mp3"];
const MAX_DURATION_SECONDS = 3;

async function getAudioDuration(file: File): Promise<number> {
	const buffer = await file.arrayBuffer();
	const ctx = new AudioContext();
	try {
		const audioBuffer = await ctx.decodeAudioData(buffer);
		return audioBuffer.duration;
	} finally {
		await ctx.close();
	}
}

function hasValidExtension(name: string): boolean {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	return ACCEPTED_EXTENSIONS.includes(ext);
}

// biome-ignore lint/suspicious/noExplicitAny: next-intl Translator uses namespace-parameterized generics; narrowing breaks assignability at the call site.
type TranslatorFn = (key: any, values?: any) => string;

interface UseSoundFileDropOptions {
	update: (patch: { recordingSoundPath: string }) => void;
	t: TranslatorFn;
}

/**
 * Manages drag-and-drop, browse, and reset logic for the recording sound file.
 * Validates file extension and audio duration before accepting.
 */
interface UseSoundFileDropReturn {
	dragOver: boolean;
	dropError: string;
	handlers: {
		onDrop: (e: DragEvent<HTMLDivElement>) => void;
		onDragOver: (e: DragEvent<HTMLDivElement>) => void;
		onDragLeave: () => void;
	};
	handleBrowse: () => Promise<void>;
	handleReset: () => void;
}

export function useSoundFileDrop({ update, t }: UseSoundFileDropOptions): UseSoundFileDropReturn {
	const [dragOver, setDragOver] = useState(false);
	const [dropError, setDropError] = useState("");

	const handleDrop = useCallback(
		async (e: DragEvent<HTMLDivElement>) => {
			e.preventDefault();
			setDragOver(false);
			setDropError("");

			const file = e.dataTransfer.files[0];
			if (!file) {
				return;
			}

			if (!hasValidExtension(file.name)) {
				setDropError(t("soundFileDropError"));
				return;
			}

			try {
				const duration = await getAudioDuration(file);
				if (duration > MAX_DURATION_SECONDS) {
					setDropError(
						t("soundFileTooLong", { max: MAX_DURATION_SECONDS, duration: duration.toFixed(1) })
					);
					return;
				}
			} catch {
				setDropError(t("soundFileUnreadable"));
				return;
			}

			const filePath = getFilePath(file);
			if (filePath) {
				update({ recordingSoundPath: filePath });
			}
		},
		[update, t]
	);

	const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		setDragOver(true);
	}, []);

	const handleDragLeave = useCallback(() => {
		setDragOver(false);
	}, []);

	const handleBrowse = async () => {
		const filePath = await dialogOpenFile(
			[{ name: "Audio", extensions: ["wav", "mp3"] }],
			"Select Recording Sound"
		);
		if (filePath) {
			update({ recordingSoundPath: filePath });
			setDropError("");
		}
	};

	const handleReset = () => {
		update({ recordingSoundPath: "" });
		setDropError("");
	};

	return {
		dragOver,
		dropError,
		handlers: { onDrop: handleDrop, onDragOver: handleDragOver, onDragLeave: handleDragLeave },
		handleBrowse,
		handleReset,
	};
}

import { type DragEvent, useCallback, useState } from "react";
import type { useTranslations } from "use-intl";
import { getFilePath } from "@/shared/api/ipc-client";

const ACCEPTED_EXTENSIONS = ["wav", "mp3"];
const MAX_DURATION_SECONDS = 3;
const TRAILING_EXTENSION_RE = /\.[^.]+$/;

type TranslatorFn = ReturnType<typeof useTranslations>;

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

async function checkDuration(
	file: File,
	t: TranslatorFn,
): Promise<string | null> {
	try {
		const duration = await getAudioDuration(file);
		if (duration > MAX_DURATION_SECONDS) {
			return t("soundFileTooLong", {
				max: MAX_DURATION_SECONDS,
				duration: duration.toFixed(1),
			});
		}
		return null;
	} catch {
		return t("soundFileUnreadable");
	}
}

type DropValidation =
	| { displayName: string; ok: true; sourcePath: string }
	| { error: string; ok: false };

/** Extension + duration acceptance checks. Returns an error string or null. */
async function fileContentError(
	file: File,
	t: TranslatorFn,
): Promise<string | null> {
	if (!hasValidExtension(file.name)) {
		return t("soundFileDropError");
	}
	return await checkDuration(file, t);
}

/**
 * Pure drop-validation pipeline: content checks → native path resolution.
 * Extracted from the hook's `onDrop` handler so the handler stays a thin
 * "validate then commit" body instead of a deep branch ladder.
 */
async function validateDroppedFile(
	file: File,
	t: TranslatorFn,
): Promise<DropValidation> {
	const contentError = await fileContentError(file, t);
	if (contentError) {
		return { ok: false, error: contentError };
	}
	const sourcePath = getFilePath(file);
	if (!sourcePath) {
		return { ok: false, error: t("soundFileUnreadable") };
	}
	return {
		ok: true,
		sourcePath,
		displayName: file.name.replace(TRAILING_EXTENSION_RE, ""),
	};
}

interface UseSoundDropOptions {
	onAdd: (sourcePath: string, displayName?: string) => Promise<unknown>;
	t: TranslatorFn;
}

interface UseSoundDropReturn {
	dragOver: boolean;
	dropError: string;
	handlers: {
		onDragLeave: () => void;
		onDragOver: (e: DragEvent<HTMLElement>) => void;
		onDrop: (e: DragEvent<HTMLElement>) => void;
	};
	resetError: () => void;
}

export function useSoundDrop({
	onAdd,
	t,
}: UseSoundDropOptions): UseSoundDropReturn {
	const [dragOver, setDragOver] = useState(false);
	const [dropError, setDropError] = useState("");

	const handleDrop = useCallback(
		async (e: DragEvent<HTMLElement>) => {
			e.preventDefault();
			setDragOver(false);
			setDropError("");
			const file = e.dataTransfer.files[0];
			if (!file) {
				return;
			}
			const result = await validateDroppedFile(file, t);
			if (!result.ok) {
				setDropError(result.error);
				return;
			}
			await onAdd(result.sourcePath, result.displayName);
		},
		[onAdd, t],
	);

	const handleDragOver = useCallback((e: DragEvent<HTMLElement>) => {
		e.preventDefault();
		setDragOver(true);
	}, []);

	const handleDragLeave = useCallback(() => {
		setDragOver(false);
	}, []);

	const resetError = useCallback(() => {
		setDropError("");
	}, []);

	return {
		dragOver,
		dropError,
		handlers: {
			onDrop: handleDrop,
			onDragOver: handleDragOver,
			onDragLeave: handleDragLeave,
		},
		resetError,
	};
}

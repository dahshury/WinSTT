"use client";

import { Progress } from "@base-ui/react/progress";
import { memo } from "react";
import { useFileTranscriptionStore } from "@/features/file-transcription";

export const FileOverlay = memo(function FileOverlay() {
	const status = useFileTranscriptionStore((s) => s.status);
	const progress = useFileTranscriptionStore((s) => s.progress);
	const message = useFileTranscriptionStore((s) => s.message);
	const fileName = useFileTranscriptionStore((s) => s.fileName);

	if (status === "idle") {
		return null;
	}

	return (
		<div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface-secondary/90">
			{status === "processing" && (
				<>
					<Progress.Root
						className="flex w-3/4 max-w-md flex-col gap-2"
						value={Math.round(progress * 100)}
					>
						<div className="flex items-center justify-between text-muted text-sm">
							<Progress.Label className="font-medium text-foreground">{fileName}</Progress.Label>
							<Progress.Value>{(formattedValue: string | null) => formattedValue}</Progress.Value>
						</div>
						<Progress.Track className="h-3 overflow-hidden rounded-full bg-surface-tertiary">
							<Progress.Indicator className="h-full rounded-full bg-teal transition-[width] duration-200 ease-out" />
						</Progress.Track>
					</Progress.Root>
					<p className="text-foreground-dim text-xs">{message}</p>
				</>
			)}
			{status === "complete" && <p className="font-medium text-sm text-success">{message}</p>}
			{status === "error" && <p className="font-medium text-error text-sm">{message}</p>}
		</div>
	);
});

import { Progress } from "@base-ui/react/progress";
import { useShallow } from "zustand/react/shallow";
import { useFileTranscriptionStore } from "@/features/file-transcription";
import { surfaceBg, surfaceBg90, useSurface } from "@/shared/lib/surface";

export function FileOverlay() {
	const { status, progress, message, fileName } = useFileTranscriptionStore(
		useShallow((s) => ({
			status: s.status,
			progress: s.progress,
			message: s.message,
			fileName: s.fileName,
		}))
	);

	const substrate = useSurface();
	const trackLevel = Math.min(substrate + 1, 8);

	if (status === "idle") {
		return null;
	}

	return (
		<div
			className={`absolute inset-0 z-raised flex flex-col items-center justify-center gap-2 ${surfaceBg90(substrate)}`}
		>
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
						<Progress.Track className={`h-3 overflow-hidden rounded-full ${surfaceBg(trackLevel)}`}>
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
}

import type { WakewordModelStatusPayload } from "@/shared/api/ipc-client";

export interface WakewordDownloadDialogProps {
	enablePending: boolean;
	onCancelDownload: () => void;
	onOpenChange: (open: boolean) => void;
	onPause: () => void;
	onResume: () => void;
	onStart: () => void;
	open: boolean;
	status: WakewordModelStatusPayload;
}

export interface WakewordDownloadProgressProps {
	status: WakewordModelStatusPayload;
}

import { create } from "zustand";

type FileTranscriptionStatus = "idle" | "processing" | "complete" | "error";

interface FileTranscriptionState {
	status: FileTranscriptionStatus;
	progress: number;
	message: string;
	fileName: string;
	setProcessing: (fileName: string) => void;
	setProgress: (progress: number, message: string) => void;
	setComplete: (fileName: string) => void;
	setError: (fileName: string, error: string) => void;
	reset: () => void;
}

export const useFileTranscriptionStore = create<FileTranscriptionState>()((set) => ({
	status: "idle",
	progress: 0,
	message: "",
	fileName: "",
	setProcessing: (fileName) =>
		set({ status: "processing", progress: 0, message: "Starting...", fileName }),
	setProgress: (progress, message) => set({ progress, message }),
	setComplete: (fileName) => {
		set({ status: "complete", progress: 1, message: "Transcription saved", fileName });
		setTimeout(() => {
			set((s) =>
				s.status === "complete" ? { status: "idle", progress: 0, message: "", fileName: "" } : s
			);
		}, 3000);
	},
	setError: (fileName, error) => {
		set({ status: "error", progress: 0, message: error, fileName });
		setTimeout(() => {
			set((s) =>
				s.status === "error" ? { status: "idle", progress: 0, message: "", fileName: "" } : s
			);
		}, 5000);
	},
	reset: () => set({ status: "idle", progress: 0, message: "", fileName: "" }),
}));

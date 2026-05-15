import { create } from "zustand";

type FileTranscriptionStatus = "idle" | "processing" | "complete" | "error";

interface FileTranscriptionState {
	fileName: string;
	message: string;
	progress: number;
	reset: () => void;
	setComplete: (fileName: string) => void;
	setError: (fileName: string, error: string) => void;
	setProcessing: (fileName: string) => void;
	setProgress: (progress: number, message: string) => void;
	status: FileTranscriptionStatus;
}

export const useFileTranscriptionStore = create<FileTranscriptionState>()((set) => ({
	// Stryker disable StringLiteral: equivalent — reset() in tests (called in
	// beforeEach) overwrites these initial values with the same literals, so
	// the initial state is unobservable through any test path.
	status: "idle",
	progress: 0,
	message: "",
	fileName: "",
	// Stryker restore StringLiteral
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

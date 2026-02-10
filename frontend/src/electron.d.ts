interface ElectronAPI {
	getPathForFile(file: File): string;
	send(channel: string, ...args: unknown[]): void;
	invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	on(channel: string, callback: (...args: unknown[]) => void): () => void;
}

declare global {
	interface Window {
		electronAPI: ElectronAPI;
	}
}

export {};

interface NativeBridge {
	getPathForFile(file: File): string;
	invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	on(channel: string, callback: (...args: unknown[]) => void): () => void;
	secureInvoke(channel: string, payload?: unknown): Promise<unknown>;
	send(channel: string, ...args: unknown[]): void;
}

declare global {
	interface Window {
		nativeBridge: NativeBridge;
	}
}

export {};

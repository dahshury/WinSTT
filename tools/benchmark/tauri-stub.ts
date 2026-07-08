// Stub for `@tauri-apps/api/*` so app components that transitively import Tauri
// can mount in a plain browser (this tool runs outside the Tauri shell). Named
// exports cover the surface the reused pickers/helpers might touch. `invoke`
// resolves to undefined instead of throwing so a stray call degrades quietly.

let warned = false;
export async function invoke<T = unknown>(cmd: string): Promise<T> {
	if (!warned) {
		warned = true;
		console.warn(
			`[benchmark] Tauri invoke("${cmd}") stubbed (running outside Tauri)`,
		);
	}
	return undefined as T;
}

export function convertFileSrc(filePath: string): string {
	return filePath;
}

export function transformCallback(): number {
	return 0;
}

export async function listen(): Promise<() => void> {
	return () => {};
}
export async function once(): Promise<() => void> {
	return () => {};
}
export async function emit(): Promise<void> {}
export async function emitTo(): Promise<void> {}

const noopWindow = {
	label: "benchmark",
	listen: async () => () => {},
	emit: async () => {},
	close: async () => {},
	setTitle: async () => {},
	onCloseRequested: async () => () => {},
};
export function getCurrentWindow() {
	return noopWindow;
}
export function getCurrentWebviewWindow() {
	return noopWindow;
}
export class Window {}
export class WebviewWindow {}

export default {
	invoke,
	convertFileSrc,
	transformCallback,
	listen,
	once,
	emit,
	emitTo,
	getCurrentWindow,
	getCurrentWebviewWindow,
};

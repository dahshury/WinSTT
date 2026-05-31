export type WindowTelemetryEventName =
	| "moved"
	| "resized"
	| "focused"
	| "blurred"
	| "shown"
	| "hidden"
	| "minimized"
	| "restored"
	| "maximized"
	| "unmaximized";

interface WindowBoundsLike {
	height: number;
	width: number;
	x: number;
	y: number;
}

export interface WindowTelemetryPayload {
	bounds: WindowBoundsLike;
	event: WindowTelemetryEventName;
}

interface BrowserWindowLike {
	getBounds(): WindowBoundsLike;
	off(eventName: string, listener: () => void): void;
	on(eventName: string, listener: () => void): void;
}

interface WindowEventMapEntry {
	electronEvent: string;
	telemetryEvent: WindowTelemetryEventName;
}

const WINDOW_EVENT_MAP: WindowEventMapEntry[] = [
	{ electronEvent: "move", telemetryEvent: "moved" },
	{ electronEvent: "resize", telemetryEvent: "resized" },
	{ electronEvent: "focus", telemetryEvent: "focused" },
	{ electronEvent: "blur", telemetryEvent: "blurred" },
	{ electronEvent: "show", telemetryEvent: "shown" },
	{ electronEvent: "hide", telemetryEvent: "hidden" },
	{ electronEvent: "minimize", telemetryEvent: "minimized" },
	{ electronEvent: "restore", telemetryEvent: "restored" },
	{ electronEvent: "maximize", telemetryEvent: "maximized" },
	{ electronEvent: "unmaximize", telemetryEvent: "unmaximized" },
];

export function createWindowTelemetryPayload(
	event: WindowTelemetryEventName,
	bounds: WindowBoundsLike
): WindowTelemetryPayload {
	return {
		event,
		bounds: {
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
		},
	};
}

export function registerWindowTelemetry(
	win: BrowserWindowLike,
	onTelemetry: (payload: WindowTelemetryPayload) => void
): () => void {
	const handlers = WINDOW_EVENT_MAP.map((entry) => {
		const listener = () => {
			onTelemetry(createWindowTelemetryPayload(entry.telemetryEvent, win.getBounds()));
		};
		win.on(entry.electronEvent, listener);
		return { eventName: entry.electronEvent, listener };
	});

	return () => {
		for (const handler of handlers) {
			win.off(handler.eventName, handler.listener);
		}
	};
}

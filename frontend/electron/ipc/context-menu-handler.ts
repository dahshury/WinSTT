import type { MenuItemConstructorOptions } from "electron";
import { isRecord } from "../lib/ipc-helpers";
import { type ContextMenuTemplateItem, convertContextMenuTemplate } from "./context-menu-template";

export interface ContextMenuIpcRequest {
	template: ContextMenuTemplateItem[];
	x?: number;
	y?: number;
}

export interface ContextMenuIpcResponse {
	selectedId: string | null;
}

export type ContextMenuIpcHandler = (
	event: unknown,
	payload: unknown
) => Promise<ContextMenuIpcResponse>;

interface PopupInput {
	onClose: () => void;
	template: MenuItemConstructorOptions[];
	x?: number;
	y?: number;
}

export interface ContextMenuPopupAdapter {
	popup: (input: PopupInput) => void;
}

export interface IpcMainHandleLike {
	handle: (channel: string, listener: ContextMenuIpcHandler) => void;
	removeHandler: (channel: string) => void;
}

export function createContextMenuIpcHandler(
	adapter: ContextMenuPopupAdapter
): ContextMenuIpcHandler {
	return async (_event, payload) => {
		const request = parseContextMenuRequest(payload);
		let selectedId: string | null = null;

		const template = convertContextMenuTemplate(request.template, (id) => {
			selectedId = id;
		});

		await new Promise<void>((resolve) => {
			adapter.popup({
				template,
				x: request.x,
				y: request.y,
				onClose: resolve,
			});
		});

		return { selectedId };
	};
}

export function registerContextMenuIpcHandler(
	ipcMain: IpcMainHandleLike,
	channel: string,
	handler: ContextMenuIpcHandler
): () => void {
	ipcMain.removeHandler(channel);
	ipcMain.handle(channel, handler);

	return () => {
		ipcMain.removeHandler(channel);
	};
}

function parseCoordinate(value: unknown, axis: "x" | "y"): number | undefined {
	if (value === undefined) {
		return;
	}
	if (!isFiniteNumber(value)) {
		throw new Error(`Context menu request ${axis} must be a finite number.`);
	}
	return value;
}

function parseContextMenuRequest(payload: unknown): ContextMenuIpcRequest {
	if (!(isRecord(payload) && Array.isArray(payload.template))) {
		throw new Error("Context menu request must contain a template array.");
	}
	return {
		template: payload.template as ContextMenuTemplateItem[],
		x: parseCoordinate(payload.x, "x"),
		y: parseCoordinate(payload.y, "y"),
	};
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

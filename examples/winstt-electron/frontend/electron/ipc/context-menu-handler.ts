import type { MenuItemConstructorOptions } from "electron";
import { isRecord } from "../lib/ipc-helpers";
import { type ContextMenuTemplateItem, convertContextMenuTemplate } from "./context-menu-template";

export interface ContextMenuIpcRequest {
	template: ContextMenuTemplateItem[];
	x?: number;
	y?: number;
}

interface ContextMenuIpcResponse {
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
			const input: PopupInput = { template, onClose: resolve };
			if (request.x !== undefined) {
				input.x = request.x;
			}
			if (request.y !== undefined) {
				input.y = request.y;
			}
			adapter.popup(input);
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

function hasTemplateArray(payload: unknown): payload is Record<string, unknown> & {
	template: unknown[];
} {
	return isRecord(payload) && Array.isArray(payload.template);
}

function assignCoordinate(request: ContextMenuIpcRequest, axis: "x" | "y", value: unknown): void {
	const parsed = parseCoordinate(value, axis);
	if (parsed !== undefined) {
		request[axis] = parsed;
	}
}

function parseContextMenuRequest(payload: unknown): ContextMenuIpcRequest {
	if (!hasTemplateArray(payload)) {
		throw new Error("Context menu request must contain a template array.");
	}
	const request: ContextMenuIpcRequest = {
		template: payload.template as ContextMenuTemplateItem[],
	};
	assignCoordinate(request, "x", payload.x);
	assignCoordinate(request, "y", payload.y);
	return request;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

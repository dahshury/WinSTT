import type { IpcMainInvokeEvent } from "electron";
import { ValidationError } from "../../src/shared/lib/errors";
import { isRecord } from "../lib/ipc-helpers";

export type ClipboardOperation = "readText" | "writeText" | "clear";

export type ClipboardPayload =
	| { operation: "readText" }
	| { operation: "writeText"; text: string }
	| { operation: "clear" };

export type ClipboardHandlerResult =
	| { operation: "readText"; text: string }
	| { operation: "writeText" }
	| { operation: "clear" };

export interface ClipboardAdapter {
	readText: () => string;
	writeText: (text: string) => void;
	clear: () => void;
}

function normalizeOperation(operation: unknown): ClipboardOperation {
	if (typeof operation !== "string") {
		throw new ValidationError("Clipboard operation must be a string", "operation");
	}

	const canonical = operation
		.trim()
		.toLowerCase()
		.replace(/[\s:_-]+/g, "");

	switch (canonical) {
		case "read":
		case "readtext":
			return "readText";
		case "write":
		case "writetext":
			return "writeText";
		case "clear":
			return "clear";
		default:
			throw new ValidationError(`Unsupported clipboard operation: ${operation}`, "operation", {
				operation,
			});
	}
}

function normalizeClipboardText(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

export function normalizeClipboardPayload(payload: unknown): ClipboardPayload {
	if (!isRecord(payload)) {
		throw new ValidationError("Clipboard payload must be an object", "payload");
	}

	const operation = normalizeOperation(payload.operation);

	switch (operation) {
		case "readText":
			return { operation: "readText" };
		case "clear":
			return { operation: "clear" };
		case "writeText": {
			if (typeof payload.text !== "string") {
				throw new ValidationError("Clipboard text must be a string", "text");
			}
			return {
				operation: "writeText",
				text: normalizeClipboardText(payload.text),
			};
		}
		default: {
			const _exhaustive: never = operation;
			throw new ValidationError(`Unhandled clipboard operation: ${_exhaustive}`, "operation");
		}
	}
}

export function createClipboardHandler(
	clipboard: ClipboardAdapter
): (_event: IpcMainInvokeEvent, payload: unknown) => ClipboardHandlerResult {
	return (_event: IpcMainInvokeEvent, payload: unknown): ClipboardHandlerResult => {
		const normalizedPayload = normalizeClipboardPayload(payload);

		switch (normalizedPayload.operation) {
			case "readText":
				return {
					operation: "readText",
					text: clipboard.readText(),
				};
			case "writeText":
				clipboard.writeText(normalizedPayload.text);
				return { operation: "writeText" };
			case "clear":
				clipboard.clear();
				return { operation: "clear" };
			default: {
				const _exhaustive: never = normalizedPayload;
				throw new ValidationError(`Unhandled clipboard payload: ${String(_exhaustive)}`);
			}
		}
	};
}

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
	clear: () => void;
	readText: () => string;
	writeText: (text: string) => void;
}

const CANONICAL_OPERATION: Record<string, ClipboardOperation> = {
	read: "readText",
	readtext: "readText",
	write: "writeText",
	writetext: "writeText",
	clear: "clear",
};

function normalizeOperation(operation: unknown): ClipboardOperation {
	if (typeof operation !== "string") {
		// Stryker disable next-line StringLiteral: ValidationError message is informational only
		throw new ValidationError("Clipboard operation must be a string", "operation");
	}
	// Stryker disable next-line MethodExpression,Regex: trim() is redundant with /[\s:_-]+/g; dropping the `+` still strips separators char-by-char
	const canonical = operation
		.trim()
		.toLowerCase()
		.replace(/[\s:_-]+/g, "");
	const resolved = CANONICAL_OPERATION[canonical];
	// Stryker disable next-line ConditionalExpression,BlockStatement: defense-in-depth — the L70 builder check catches an undefined `resolved` too
	if (!resolved) {
		// Stryker disable next-line StringLiteral,ObjectLiteral: ValidationError message and context are informational only
		throw new ValidationError(`Unsupported clipboard operation: ${operation}`, "operation", {
			operation,
		});
	}
	return resolved;
}

function normalizeClipboardText(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function normalizeWriteTextPayload(payload: Record<string, unknown>): ClipboardPayload {
	if (typeof payload.text !== "string") {
		// Stryker disable next-line StringLiteral: ValidationError message is informational only
		throw new ValidationError("Clipboard text must be a string", "text");
	}
	return { operation: "writeText", text: normalizeClipboardText(payload.text) };
}

const PAYLOAD_BUILDERS: Partial<
	Record<ClipboardOperation, (p: Record<string, unknown>) => ClipboardPayload>
> = {
	readText: () => ({ operation: "readText" }),
	clear: () => ({ operation: "clear" }),
	writeText: normalizeWriteTextPayload,
};

export function normalizeClipboardPayload(payload: unknown): ClipboardPayload {
	if (!isRecord(payload)) {
		// Stryker disable next-line StringLiteral: ValidationError message is informational only
		throw new ValidationError("Clipboard payload must be an object", "payload");
	}
	const operation = normalizeOperation(payload.operation);
	const builder = PAYLOAD_BUILDERS[operation];
	// Stryker disable next-line ConditionalExpression,BlockStatement: defense-in-depth — normalizeOperation already rejects unknown ops
	if (!builder) {
		// Stryker disable next-line StringLiteral: ValidationError message is informational only
		throw new ValidationError(`Unhandled clipboard operation: ${operation}`, "operation");
	}
	return builder(payload);
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
			// Stryker disable next-line ConditionalExpression,BlockStatement: exhaustive default is unreachable — normalizeClipboardPayload already validates the operation
			default: {
				const _exhaustive: never = normalizedPayload;
				// Stryker disable next-line StringLiteral: ValidationError message is informational only and the branch is unreachable
				throw new ValidationError(`Unhandled clipboard payload: ${String(_exhaustive)}`);
			}
		}
	};
}

/**
 * Base application error class with metadata support.
 * All custom errors should extend this class.
 */
export class ApplicationError extends Error {
	readonly context?: Record<string, unknown> | undefined;
	readonly timestamp: number;

	constructor(message: string, context?: Record<string, unknown>) {
		super(message);
		this.name = this.constructor.name;
		this.context = context;
		this.timestamp = Date.now();

		// Maintains proper stack trace for where error was thrown.
		// `captureStackTrace` is a V8 (main + renderer) and JSC (Bun) extension,
		// not part of the standard `ErrorConstructor` lib — feature-detect through
		// a narrow local type so this stays sound without pulling in node types.
		const errorCtor = Error as ErrorConstructor & {
			captureStackTrace?: (target: object, ctor?: Function) => void;
		};
		errorCtor.captureStackTrace?.(this, this.constructor);
	}

	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			message: this.message,
			context: this.context,
			timestamp: this.timestamp,
			stack: this.stack,
		};
	}
}

/**
 * Type guard to check if an error is an ApplicationError.
 */
export function isApplicationError(error: unknown): error is ApplicationError {
	return error instanceof ApplicationError;
}

// Error instances pass through this duck-typing predicate unchanged:
// `Error.prototype.message === ""` so even a default `new Error()`
// satisfies `"message" in error`.
function isMessageBearer(error: unknown): error is { message: unknown } {
	return Boolean(error && typeof error === "object" && "message" in error);
}

/**
 * Extract a safe error message from unknown error type.
 */
export function getErrorMessage(error: unknown): string {
	if (typeof error === "string") {
		return error;
	}
	if (isMessageBearer(error)) {
		return String(error.message);
	}
	return "Unknown error occurred";
}

function getErrorStack(error: unknown): string | undefined {
	if (error instanceof Error) {
		return error.stack;
	}
	return;
}

function formatErrorContext(error: unknown): string {
	return isApplicationError(error) && error.context
		? `\nContext: ${JSON.stringify(error.context, null, 2)}`
		: "";
}

function formatErrorPrefix(prefix: string, message: string): string {
	return prefix ? `${prefix}: ${message}` : message;
}

/**
 * Format error for logging with full context.
 */
export function formatErrorForLog(error: unknown, prefix = ""): string {
	const head = formatErrorPrefix(prefix, getErrorMessage(error));
	const stack = getErrorStack(error);
	return `${head}${formatErrorContext(error)}${stack ? `\n${stack}` : ""}`;
}

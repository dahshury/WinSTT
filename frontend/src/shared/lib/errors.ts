/**
 * Base application error class with metadata support.
 * All custom errors should extend this class.
 */
export class ApplicationError extends Error {
	public readonly context?: Record<string, unknown>;
	public readonly timestamp: number;

	constructor(message: string, context?: Record<string, unknown>) {
		super(message);
		this.name = this.constructor.name;
		this.context = context;
		this.timestamp = Date.now();

		// Maintains proper stack trace for where error was thrown (V8 only)
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor);
		}
	}

	public toJSON(): Record<string, unknown> {
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
 * Validation error - thrown when input validation fails.
 */
export class ValidationError extends ApplicationError {
	public readonly field?: string;

	constructor(message: string, field?: string, context?: Record<string, unknown>) {
		super(message, context);
		this.field = field;
	}

	public override toJSON(): Record<string, unknown> {
		return {
			...super.toJSON(),
			field: this.field,
		};
	}
}

/**
 * Not found error - thrown when a resource is not found.
 */
export class NotFoundError extends ApplicationError {
	public readonly resource: string;
	public readonly identifier?: string | number;

	constructor(resource: string, identifier?: string | number, context?: Record<string, unknown>) {
		const msg = identifier
			? `${resource} with identifier "${identifier}" not found`
			: `${resource} not found`;
		super(msg, context);
		this.resource = resource;
		this.identifier = identifier;
	}

	public override toJSON(): Record<string, unknown> {
		return {
			...super.toJSON(),
			resource: this.resource,
			identifier: this.identifier,
		};
	}
}

/**
 * Connection error - thrown when network/IPC connection fails.
 */
export class ConnectionError extends ApplicationError {
	public readonly endpoint?: string;
	public readonly retryable: boolean;

	constructor(
		message: string,
		endpoint?: string,
		retryable = true,
		context?: Record<string, unknown>
	) {
		super(message, context);
		this.endpoint = endpoint;
		this.retryable = retryable;
	}

	public override toJSON(): Record<string, unknown> {
		return {
			...super.toJSON(),
			endpoint: this.endpoint,
			retryable: this.retryable,
		};
	}
}

/**
 * Timeout error - thrown when an operation times out.
 */
export class TimeoutError extends ApplicationError {
	public readonly timeoutMs: number;
	public readonly operation?: string;

	constructor(timeoutMs: number, operation?: string, context?: Record<string, unknown>) {
		const msg = operation
			? `Operation "${operation}" timed out after ${timeoutMs}ms`
			: `Operation timed out after ${timeoutMs}ms`;
		super(msg, context);
		this.timeoutMs = timeoutMs;
		this.operation = operation;
	}

	public override toJSON(): Record<string, unknown> {
		return {
			...super.toJSON(),
			timeoutMs: this.timeoutMs,
			operation: this.operation,
		};
	}
}

/**
 * IPC error - thrown when IPC communication fails.
 */
export class IpcError extends ApplicationError {
	public readonly channel: string;
	public readonly ipcOperation: "invoke" | "send" | "on";

	constructor(
		message: string,
		channel: string,
		operation: "invoke" | "send" | "on",
		context?: Record<string, unknown>
	) {
		super(message, context);
		this.channel = channel;
		this.ipcOperation = operation;
	}

	public override toJSON(): Record<string, unknown> {
		return {
			...super.toJSON(),
			channel: this.channel,
			ipcOperation: this.ipcOperation,
		};
	}
}

/**
 * File system error - thrown when file operations fail.
 */
export class FileSystemError extends ApplicationError {
	public readonly filePath: string;
	public readonly operation: "read" | "write" | "delete" | "exists" | "stat";

	constructor(
		message: string,
		filePath: string,
		operation: "read" | "write" | "delete" | "exists" | "stat",
		context?: Record<string, unknown>
	) {
		super(message, context);
		this.filePath = filePath;
		this.operation = operation;
	}

	public override toJSON(): Record<string, unknown> {
		return {
			...super.toJSON(),
			filePath: this.filePath,
			operation: this.operation,
		};
	}
}

/**
 * Process spawn error - thrown when spawning external process fails.
 */
export class ProcessSpawnError extends ApplicationError {
	public readonly command: string;
	public readonly exitCode?: number;

	constructor(
		message: string,
		command: string,
		exitCode?: number,
		context?: Record<string, unknown>
	) {
		super(message, context);
		this.command = command;
		this.exitCode = exitCode;
	}

	public override toJSON(): Record<string, unknown> {
		return {
			...super.toJSON(),
			command: this.command,
			exitCode: this.exitCode,
		};
	}
}

/**
 * Type guard to check if an error is an ApplicationError.
 */
export function isApplicationError(error: unknown): error is ApplicationError {
	return error instanceof ApplicationError;
}

/**
 * Extract a safe error message from unknown error type.
 */
export function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	if (error && typeof error === "object" && "message" in error) {
		return String(error.message);
	}
	return "Unknown error occurred";
}

/**
 * Extract error stack trace safely.
 */
export function getErrorStack(error: unknown): string | undefined {
	if (error instanceof Error) {
		return error.stack;
	}
	return undefined;
}

/**
 * Format error for logging with full context.
 */
export function formatErrorForLog(error: unknown, prefix = ""): string {
	const message = getErrorMessage(error);
	const stack = getErrorStack(error);

	let result = prefix ? `${prefix}: ${message}` : message;

	if (isApplicationError(error) && error.context) {
		result += `\nContext: ${JSON.stringify(error.context, null, 2)}`;
	}

	if (stack) {
		result += `\n${stack}`;
	}

	return result;
}

/**
 * Retry wrapper for async operations with exponential backoff.
 */
export async function retryAsync<T>(
	fn: () => Promise<T>,
	options: {
		maxAttempts?: number;
		delayMs?: number;
		backoffMultiplier?: number;
		shouldRetry?: (error: unknown, attempt: number) => boolean;
		onRetry?: (error: unknown, attempt: number) => void;
	} = {}
): Promise<T> {
	const {
		maxAttempts = 3,
		delayMs = 1000,
		backoffMultiplier = 2,
		shouldRetry = () => true,
		onRetry,
	} = options;

	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;

			if (attempt === maxAttempts || !shouldRetry(error, attempt)) {
				throw error;
			}

			onRetry?.(error, attempt);

			const delay = delayMs * backoffMultiplier ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	throw lastError;
}

/**
 * Wrap async function to handle errors gracefully and prevent unhandled rejections.
 */
export function wrapAsync<TArgs extends unknown[], TReturn>(
	fn: (...args: TArgs) => Promise<TReturn>,
	errorHandler?: (error: unknown, args: TArgs) => void
): (...args: TArgs) => Promise<TReturn | undefined> {
	return async (...args: TArgs): Promise<TReturn | undefined> => {
		try {
			return await fn(...args);
		} catch (error) {
			errorHandler?.(error, args);
			console.error(formatErrorForLog(error, `Error in ${fn.name || "async function"}`));
			return undefined;
		}
	};
}

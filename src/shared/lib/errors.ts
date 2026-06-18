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
 * Validation error - thrown when input validation fails.
 */
export class ValidationError extends ApplicationError {
	readonly field?: string | undefined;

	constructor(
		message: string,
		field?: string,
		context?: Record<string, unknown>,
	) {
		super(message, context);
		this.field = field;
	}

	override toJSON(): Record<string, unknown> {
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
	readonly resource: string;
	readonly identifier?: string | number | undefined;

	constructor(
		resource: string,
		identifier?: string | number,
		context?: Record<string, unknown>,
	) {
		const msg = identifier
			? `${resource} with identifier "${identifier}" not found`
			: `${resource} not found`;
		super(msg, context);
		this.resource = resource;
		this.identifier = identifier;
	}

	override toJSON(): Record<string, unknown> {
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
	readonly endpoint?: string | undefined;
	readonly retryable: boolean;

	constructor(
		message: string,
		endpoint?: string,
		retryable = true,
		context?: Record<string, unknown>,
	) {
		super(message, context);
		this.endpoint = endpoint;
		this.retryable = retryable;
	}

	override toJSON(): Record<string, unknown> {
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
	readonly timeoutMs: number;
	readonly operation?: string | undefined;

	constructor(
		timeoutMs: number,
		operation?: string,
		context?: Record<string, unknown>,
	) {
		const msg = operation
			? `Operation "${operation}" timed out after ${timeoutMs}ms`
			: `Operation timed out after ${timeoutMs}ms`;
		super(msg, context);
		this.timeoutMs = timeoutMs;
		this.operation = operation;
	}

	override toJSON(): Record<string, unknown> {
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
	readonly channel: string;
	readonly ipcOperation: "invoke" | "send" | "on";

	constructor(
		message: string,
		channel: string,
		operation: "invoke" | "send" | "on",
		context?: Record<string, unknown>,
	) {
		super(message, context);
		this.channel = channel;
		this.ipcOperation = operation;
	}

	override toJSON(): Record<string, unknown> {
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
	readonly filePath: string;
	readonly operation: "read" | "write" | "delete" | "exists" | "stat";

	constructor(
		message: string,
		filePath: string,
		operation: "read" | "write" | "delete" | "exists" | "stat",
		context?: Record<string, unknown>,
	) {
		super(message, context);
		this.filePath = filePath;
		this.operation = operation;
	}

	override toJSON(): Record<string, unknown> {
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
	readonly command: string;
	readonly exitCode?: number | undefined;

	constructor(
		message: string,
		command: string,
		exitCode?: number,
		context?: Record<string, unknown>,
	) {
		super(message, context);
		this.command = command;
		this.exitCode = exitCode;
	}

	override toJSON(): Record<string, unknown> {
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

/**
 * Extract error stack trace safely.
 */
export function getErrorStack(error: unknown): string | undefined {
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

interface RetryConfig {
	backoffMultiplier: number;
	delayMs: number;
	maxAttempts: number;
	onRetry?: (error: unknown, attempt: number) => void;
	shouldRetry: (error: unknown, attempt: number) => boolean;
}

function shouldKeepRetrying(
	attempt: number,
	error: unknown,
	cfg: RetryConfig,
): boolean {
	return attempt < cfg.maxAttempts && cfg.shouldRetry(error, attempt);
}

async function waitBeforeRetry(
	error: unknown,
	attempt: number,
	cfg: RetryConfig,
): Promise<void> {
	cfg.onRetry?.(error, attempt);
	const delay = cfg.delayMs * cfg.backoffMultiplier ** (attempt - 1);
	await new Promise((resolve) => setTimeout(resolve, delay));
}

async function tryAttempt<T>(
	fn: () => Promise<T>,
	attempt: number,
	cfg: RetryConfig,
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (!shouldKeepRetrying(attempt, error, cfg)) {
			throw error;
		}
		await waitBeforeRetry(error, attempt, cfg);
		return tryAttempt(fn, attempt + 1, cfg);
	}
}

interface RetryOptions {
	backoffMultiplier?: number;
	delayMs?: number;
	maxAttempts?: number;
	onRetry?: (error: unknown, attempt: number) => void;
	shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const RETRY_DEFAULTS = {
	maxAttempts: 3,
	delayMs: 1000,
	backoffMultiplier: 2,
	shouldRetry: () => true,
} satisfies Partial<RetryConfig>;

function buildRetryConfig(options: RetryOptions): RetryConfig {
	return { ...RETRY_DEFAULTS, ...options } as RetryConfig;
}

/**
 * Retry wrapper for async operations with exponential backoff.
 */
export function retryAsync<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	return tryAttempt(fn, 1, buildRetryConfig(options));
}

/**
 * Wrap async function to handle errors gracefully and prevent unhandled rejections.
 */
export function wrapAsync<TArgs extends unknown[], TReturn>(
	fn: (...args: TArgs) => Promise<TReturn>,
	errorHandler?: (error: unknown, args: TArgs) => void,
): (...args: TArgs) => Promise<TReturn | undefined> {
	return async (...args: TArgs): Promise<TReturn | undefined> => {
		try {
			return await fn(...args);
		} catch (error) {
			errorHandler?.(error, args);
			console.error(
				formatErrorForLog(error, `Error in ${fn.name || "async function"}`),
			);
			return;
		}
	};
}

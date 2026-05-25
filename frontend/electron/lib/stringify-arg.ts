/**
 * Pure helpers for {@link stringifyArg} (in `debug-log.ts`).
 *
 * Kept in their own file because `debug-log.ts` is mocked process-wide by
 * many test files via `mock.module("../lib/debug-log", ...)`, which shadows
 * the real implementation and prevents coverage from being collected. Living
 * here means coverage actually reflects the unit tests in `stringify-arg.test.ts`.
 */

export function jsonStringifyOrString(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function identityString(value: unknown): string {
	return value as string;
}

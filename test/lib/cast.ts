/**
 * Test-only typed casts with explicit, greppable intent.
 *
 * The single legitimate reason to reach for `as unknown as T` in tests is to
 * deliberately feed a value the type system forbids — proving that a runtime
 * guard rejects bad input. Spelling that out as `asInvalid<string>(42)` instead
 * of `42 as unknown as string` makes the intent obvious, keeps the unsafe step
 * in one auditable place, and lets the enforcement lint rule (`noExplicitAny` /
 * the cast guard) flag *accidental* casts while allowing these intentional ones.
 *
 * Do NOT use this to paper over a mock that should match a real interface — for
 * that, build a typed factory whose return type IS the real type so the compiler
 * catches interface drift. `asInvalid` is exclusively for "I am testing that
 * passing the wrong type is handled".
 */
export function asInvalid<T>(value: unknown): T {
	return value as T;
}

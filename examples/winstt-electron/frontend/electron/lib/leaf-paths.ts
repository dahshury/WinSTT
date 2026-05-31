/**
 * Compile-time leaf-path utilities for the settings tree.
 *
 * Hand-maintained dotted-path registries are a recurring source of silent
 * bugs in this codebase. The walker bug that fed every window
 * ``model.model = "tiny"`` for a week (see ``secret-storage.ts`` history)
 * existed because ``SECRET_DOT_PATHS: readonly string[]`` accepted ANY
 * string; the walker only descended two levels, but the registry contained
 * three-level paths. Nothing flagged it.
 *
 * These types make that bug class impossible at compile time:
 *
 *   - ``LeafPaths<T>`` enumerates every dotted path that lands on a primitive
 *     leaf in ``T``. ``"integrations.openai"`` is NOT a leaf — only
 *     ``"integrations.openai.apiKey"`` is.
 *
 *   - ``LeafPathsToString<T>`` further restricts to leaves whose value is
 *     ``string`` (so the secrets walker can't accidentally encrypt a boolean
 *     or coerce an object to ``""``).
 *
 * Apply via ``as const satisfies readonly LeafPaths<AppSettings>[]`` on any
 * registry of dotted paths — typos and 2-vs-3-level mismatches become
 * compile errors with a "did you mean…?" suggestion from TypeScript.
 *
 * Recursion is depth-capped at 6 (the schema is currently 3 deep; the cap
 * keeps the TypeScript instantiation budget bounded if the schema grows).
 */

type LeafPathsImpl<T, Depth extends readonly unknown[]> = Depth["length"] extends 6
	? never
	: T extends object
		? {
				[K in keyof T & string]: T[K] extends object
					? T[K] extends readonly unknown[]
						? K
						: `${K}.${LeafPathsImpl<T[K], [...Depth, unknown]>}`
					: K;
			}[keyof T & string]
		: never;

/** Every dotted path that lands on a primitive (or array) leaf in ``T``. */
export type LeafPaths<T> = LeafPathsImpl<T, []>;

type LeafPathsToStringImpl<T, Depth extends readonly unknown[]> = Depth["length"] extends 6
	? never
	: T extends string
		? "__leaf__"
		: T extends object
			? {
					[K in keyof T & string]: T[K] extends string
						? K
						: T[K] extends object
							? T[K] extends readonly unknown[]
								? never
								: `${K}.${LeafPathsToStringImpl<T[K], [...Depth, unknown]>}`
							: never;
				}[keyof T & string]
			: never;

/**
 * Every dotted path that lands on a ``string`` leaf in ``T``. Used by
 * ``SECRET_DOT_PATHS`` to ensure each entry actually points at a string
 * field — encrypting a non-string field would silently corrupt it.
 */
export type LeafPathsToString<T> = Exclude<LeafPathsToStringImpl<T, []>, "__leaf__">;

import type { Locale } from "./config";
import { DEFAULT_LOCALE } from "./config";

// Per-locale lazy loading.
//
// Previously this module statically `import`ed all 20 `messages/*.json`
// bundles (~1.5 MB) and exposed them as one synchronous map. Because every
// Tauri window's entry pulls in `IntlProvider`, that static map made
// *each* window eagerly bundle + modulepreload all 20 locales — the single
// largest chunk in the build (~1.37 MB) — even though a window only ever shows
// ONE locale.
//
// `import.meta.glob` (lazy / non-eager) hands back a map of dynamic-import
// loaders, so Rollup emits one code-split chunk per locale JSON and the active
// window only fetches the locale it actually renders.
// Vite replaces the `import.meta.glob(...)` call below with the generated
// per-locale loader map at transform time (the AST replacement happens
// regardless of the surrounding try/catch). The guard only matters for
// non-Vite runtimes such as `bun test`, where `import.meta.glob` is undefined
// and the call would throw — there we fall back to an empty map so importing
// this module never crashes.
const loaders: Record<
	string,
	() => Promise<{ default: Record<string, unknown> }>
> = (() => {
	try {
		return import.meta.glob<{ default: Record<string, unknown> }>(
			"../../../messages/*.json",
		);
	} catch {
		return {};
	}
})();

const localePath = (locale: string): string =>
	`../../../messages/${locale}.json`;

// Locales that physically have a `messages/<code>.json` bundle on disk. Derived
// from the glob so it can never drift from the actual files. `config.ts`'s
// `LOCALES` is the *advertised* list (with its picker labels etc.); this is the
// set we can actually load. They are kept in parity by `bun check:i18n`.
export const SUPPORTED_LOCALES: readonly string[] = Object.keys(loaders)
	.map((path) => path.replace(/^.*\/(.+)\.json$/, "$1"))
	.sort();

/**
 * Lazily load the message bundle for `locale`, falling back to the default
 * locale ({@link DEFAULT_LOCALE}) when the requested locale has no bundle.
 *
 * Each call resolves to the parsed JSON object. Per-locale bundles are allowed
 * to lag `en` in key coverage — use-intl falls back to `en` at runtime, and
 * `bun check:i18n` is the parity gate.
 */
export async function loadMessages(
	locale: string,
): Promise<Record<string, unknown>> {
	const loader =
		loaders[localePath(locale)] ?? loaders[localePath(DEFAULT_LOCALE)];
	if (!loader) {
		// Should be unreachable: en.json always exists. Return an empty bundle so
		// the provider can still render (use-intl tolerates missing messages).
		return {};
	}
	const mod = await loader();
	return mod.default;
}

export type { Locale };

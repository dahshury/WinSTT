// Synchronous IntlProvider for tests.
//
// The real `@/app/providers/IntlProvider` loads its message bundle LAZILY via
// `import.meta.glob` (one code-split chunk per locale) and renders `null` until
// the async load resolves. That is correct in production (the per-window
// Suspense fallback gates first paint), but it breaks unit tests: under
// `bun test` there is no Vite transform, so `import.meta.glob` is undefined →
// `loadMessages` resolves to an EMPTY bundle, and even that resolves a tick too
// late for a synchronous `render(...)` + immediate assertion — so children
// never mount.
//
// This test double renders children SYNCHRONOUSLY with the real English bundle
// (statically imported, so every `t("…")` resolves to a real string instead of
// a raw key). It honours the active `useLocaleStore` locale so locale-switch
// tests still re-render, but always serves the `en` messages — tests assert on
// behaviour/structure, not on locale-specific copy. Installed globally from
// `test/preload.ts` via `mock.module`.
import type { ReactNode } from "react";
import { IntlProvider as UseIntlProvider } from "use-intl/react";
import { useLocaleStore } from "@/shared/i18n";
import enMessages from "../../messages/en.json";

export function IntlProvider({ children }: { children: ReactNode }) {
	const locale = useLocaleStore((s) => s.locale);
	return (
		<UseIntlProvider
			locale={locale}
			messages={enMessages as Record<string, unknown>}
			timeZone="UTC"
		>
			{children}
		</UseIntlProvider>
	);
}

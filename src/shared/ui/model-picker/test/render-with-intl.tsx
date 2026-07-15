import {
	render as rtlRender,
	type RenderOptions,
	type RenderResult,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
// `@/app/providers/IntlProvider` is swapped for a synchronous English-bundle
// double in `test/preload.ts`, so this wraps picker components in the same intl
// context they always run inside in production (the picker is app code rendered
// within the app's IntlProvider). Without it, `useTranslations` throws.
import { IntlProvider } from "@/app/providers/IntlProvider";

function IntlWrapper({ children }: { children: ReactNode }) {
	return <IntlProvider>{children}</IntlProvider>;
}

/** Drop-in for `@testing-library/react`'s `render` that supplies the intl
 *  context every picker component needs. Tests import this instead of the raw
 *  `render`. */
export function render(
	ui: ReactElement,
	options?: Omit<RenderOptions, "wrapper">,
): RenderResult {
	return rtlRender(ui, { wrapper: IntlWrapper, ...options });
}

export * from "@testing-library/react";

import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";
import es from "../../../messages/es.json";
import fr from "../../../messages/fr.json";
import hi from "../../../messages/hi.json";
import zh from "../../../messages/zh.json";
import type { Locale } from "./config";

type Messages = typeof en;

// Typed as Record<Locale, Messages> WITH a deferred cast: non-en locales are
// allowed to lag in key coverage (next-intl falls back to en at runtime).
// scripts/verify-i18n.ts is the runtime/CI check for missing translations.
// The cast is constrained to `unknown as` so we still catch shape divergence
// when a new locale is added without a bundle, but we don't fail the build
// every time English adds a key before the translators catch up.
export const messages: Record<Locale, Messages> = {
	en,
	zh: zh as unknown as Messages,
	es: es as unknown as Messages,
	hi: hi as unknown as Messages,
	fr: fr as unknown as Messages,
	ar: ar as unknown as Messages,
};

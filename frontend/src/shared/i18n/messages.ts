import ar from "../../../messages/ar.json";
import bg from "../../../messages/bg.json";
import cs from "../../../messages/cs.json";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import es from "../../../messages/es.json";
import fr from "../../../messages/fr.json";
import he from "../../../messages/he.json";
import hi from "../../../messages/hi.json";
import it from "../../../messages/it.json";
import ja from "../../../messages/ja.json";
import ko from "../../../messages/ko.json";
import pl from "../../../messages/pl.json";
import pt from "../../../messages/pt.json";
import ru from "../../../messages/ru.json";
import sv from "../../../messages/sv.json";
import tr from "../../../messages/tr.json";
import uk from "../../../messages/uk.json";
import vi from "../../../messages/vi.json";
import zh from "../../../messages/zh.json";
import type { Locale } from "./config";

type Messages = typeof en;

// Typed as Record<Locale, Messages> WITH a deferred cast: non-en locales are
// allowed to lag in key coverage (use-intl falls back to en at runtime).
// scripts/verify-i18n.ts is the runtime/CI check for missing translations.
// The cast is constrained to `unknown as` so we still catch shape divergence
// when a new locale is added without a bundle, but we don't fail the build
// every time English adds a key before the translators catch up.
//
// Newly seeded baselines (de/ja/ko/pt/ru/it/pl/tr/sv/cs/bg/he/uk/vi) are
// English copies and need community translation passes — the parity gate
// passes today, the `--strict` mode does NOT, and that's intentional: it
// flags the residual translation work so a future strict CI flip is one
// configuration line, not a separate sweep.
export const messages: Record<Locale, Messages> = {
	en,
	ar: ar as unknown as Messages,
	bg: bg as unknown as Messages,
	cs: cs as unknown as Messages,
	de: de as unknown as Messages,
	es: es as unknown as Messages,
	fr: fr as unknown as Messages,
	he: he as unknown as Messages,
	hi: hi as unknown as Messages,
	it: it as unknown as Messages,
	ja: ja as unknown as Messages,
	ko: ko as unknown as Messages,
	pl: pl as unknown as Messages,
	pt: pt as unknown as Messages,
	ru: ru as unknown as Messages,
	sv: sv as unknown as Messages,
	tr: tr as unknown as Messages,
	uk: uk as unknown as Messages,
	vi: vi as unknown as Messages,
	zh: zh as unknown as Messages,
};

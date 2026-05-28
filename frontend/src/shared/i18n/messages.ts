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

// `messages` is typed as Record<Locale, Messages> WITH a deferred per-locale
// cast: non-en bundles are allowed to lag in key coverage (use-intl falls back
// to en at runtime); scripts/verify-i18n.ts is the runtime/CI parity check.
//
// `en` stays un-cast so it remains the type-checked source of truth (it IS
// `Messages`). Every other bundle goes through the single `asMessages` helper —
// centralising the "shape divergence allowed" decision in one auditable place.
// A missing bundle (new locale added without its JSON) is still a compile error;
// English adding a key before translators catch up is not.
//
// Newly seeded baselines (de/ja/ko/pt/ru/it/pl/tr/sv/cs/bg/he/uk/vi) are
// English copies and need community translation passes — the parity gate
// passes today, the `--strict` mode does NOT, and that's intentional: it
// flags the residual translation work so a future strict CI flip is one
// configuration line, not a separate sweep.
const asMessages = (bundle: unknown): Messages => bundle as Messages;

export const messages: Record<Locale, Messages> = {
	en,
	ar: asMessages(ar),
	bg: asMessages(bg),
	cs: asMessages(cs),
	de: asMessages(de),
	es: asMessages(es),
	fr: asMessages(fr),
	he: asMessages(he),
	hi: asMessages(hi),
	it: asMessages(it),
	ja: asMessages(ja),
	ko: asMessages(ko),
	pl: asMessages(pl),
	pt: asMessages(pt),
	ru: asMessages(ru),
	sv: asMessages(sv),
	tr: asMessages(tr),
	uk: asMessages(uk),
	vi: asMessages(vi),
	zh: asMessages(zh),
};

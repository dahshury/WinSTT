import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";
import es from "../../../messages/es.json";
import fr from "../../../messages/fr.json";
import hi from "../../../messages/hi.json";
import zh from "../../../messages/zh.json";
import type { Locale } from "./config";

// Non-en locales are intentionally allowed to lag behind en; missing keys fall back to en at runtime
// via next-intl's default-locale resolution. Cast so locale drift doesn't break the type checker.
export const messages = { en, zh, es, hi, fr, ar } as Record<Locale, typeof en>;

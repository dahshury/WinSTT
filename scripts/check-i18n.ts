/**
 * i18n parity / translation-coverage checker.
 *
 * Compares every `messages/<locale>.json` bundle against the English source of
 * truth (`messages/en.json` — the only bundle that's type-checked) and reports,
 * per locale:
 *
 *   • missing      — keys present in en.json but absent here (renders as English
 *                    fallback at runtime).
 *   • stale        — keys present here but NOT in en.json (dead leftovers from a
 *                    removed feature; they bloat the file and confuse translators).
 *   • untranslated — string keys whose value is byte-identical to English. Most
 *                    are genuinely untranslated; a handful are legitimately equal
 *                    across languages (brand/product/tech terms like "WinSTT",
 *                    "ONNX", "LLM"). The `IDENTICAL_BY_DESIGN` allowlist below
 *                    suppresses the known-OK ones so the count reflects real work.
 *
 * Usage:
 *   bun scripts/check-i18n.ts            # human report; exits 1 on missing/stale
 *   bun scripts/check-i18n.ts --strict   # also exit 1 if anything is untranslated
 *   bun scripts/check-i18n.ts --verbose  # list every offending key, not just N
 *   bun scripts/check-i18n.ts --json     # machine-readable report to stdout
 *
 * This is the live replacement for the old `check-translations.ts`, which pointed
 * at the unused `src/i18n/locales/**` tree instead of the bundles that actually
 * ship (`messages/*.json`, imported by `src/shared/i18n/messages.ts`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_DIR = path.join(__dirname, "..", "messages");
const REFERENCE = "en";

const args = new Set(process.argv.slice(2));
const STRICT = args.has("--strict");
const VERBOSE = args.has("--verbose");
const JSON_OUT = args.has("--json");
const PREVIEW = 15;

/**
 * Keys whose value is allowed to equal English in any locale: brand names,
 * product names, and untranslatable technical tokens. These never count as
 * "untranslated". Keep this list tight — when in doubt, translate.
 */
const IDENTICAL_BY_DESIGN = new Set<string>([
  "titleBar.appName", // "WinSTT"
  "about.appInfoTitle", // "Application" (cognate / proper noun in many locales)
  "about.appVersion", // "Version"
  "about.electronVersion", // "Electron" (framework name)
  "about.nodeVersion", // "Node" (runtime name)
  "settings.tabLlm", // "LLM"
  // Brand / product names — identical in every locale.
  "integrations.openai", // "OpenAI"
  "integrations.groupOpenai", // "OpenAI"
  "integrations.elevenlabs", // "ElevenLabs"
  "integrations.groupElevenlabs", // "ElevenLabs"
  "llm.providerAppleIntelligence", // "Apple Intelligence"
  // Acronyms / hardware tokens kept verbatim in UIs.
  "mainPage.pttButton", // "PTT"
  "tray.modePtt", // "PTT"
  "model.deviceCpuLabel", // "CPU"
  // Literal keyboard combos.
  "general.autoSubmitKeyEnter", // "Enter"
  "general.autoSubmitKeyCtrlEnter", // "Ctrl+Enter"
  // API-key placeholders — fixed token prefixes, never translated.
  "integrations.openaiApiKeyPlaceholder", // "sk-…"
  "integrations.elevenlabsApiKeyPlaceholder", // "el-…"
  "llm.openrouterApiKeyPlaceholder", // "sk-or-v1-…"
  // Format strings with no translatable words (placeholders + units only).
  "llm.pullProgress", // "{percent}% — {status}"
  "llm.modelSizeLabel", // "{size} GB"
  "model.resourceWarning.rowHintOk", // "~{req} · {target}"
]);

type Json = Record<string, unknown>;

const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};
const c = (text: string, color: keyof typeof colors): string =>
  JSON_OUT ? text : `${colors[color]}${text}${colors.reset}`;

/** Flatten a nested message object into `{ "a.b.c": value }` leaf entries. */
function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Json)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else {
    out[prefix] = obj;
  }
  return out;
}

function loadBundle(locale: string): Record<string, unknown> {
  const file = path.join(MESSAGES_DIR, `${locale}.json`);
  return flatten(JSON.parse(fs.readFileSync(file, "utf8")));
}

interface LocaleReport {
  locale: string;
  missing: string[];
  stale: string[];
  untranslated: string[];
  translated: number;
  total: number;
}

function analyze(): { reference: Record<string, unknown>; reports: LocaleReport[] } {
  const reference = loadBundle(REFERENCE);
  const refStringKeys = Object.entries(reference).filter(
    ([, v]) => typeof v === "string" && (v as string).trim() !== "",
  );

  const locales = fs
    .readdirSync(MESSAGES_DIR)
    .filter((f) => f.endsWith(".json") && f !== `${REFERENCE}.json`)
    .map((f) => f.slice(0, -5))
    .sort();

  const reports: LocaleReport[] = locales.map((locale) => {
    const bundle = loadBundle(locale);
    const missing = Object.keys(reference).filter((k) => !(k in bundle));
    const stale = Object.keys(bundle).filter((k) => !(k in reference));

    const untranslated: string[] = [];
    let translated = 0;
    for (const [k, enVal] of refStringKeys) {
      if (IDENTICAL_BY_DESIGN.has(k)) continue;
      const val = bundle[k];
      if (typeof val !== "string") continue;
      if (val === enVal) untranslated.push(k);
      else if (val.trim() !== "") translated++;
    }

    return {
      locale,
      missing,
      stale,
      untranslated,
      translated,
      total: refStringKeys.length,
    };
  });

  return { reference, reports };
}

function printList(label: string, keys: string[], color: keyof typeof colors): void {
  if (keys.length === 0) return;
  console.log(c(`    ${label} (${keys.length}):`, color));
  const shown = VERBOSE ? keys : keys.slice(0, PREVIEW);
  for (const k of shown) console.log(c(`      · ${k}`, "gray"));
  if (!VERBOSE && keys.length > PREVIEW) {
    console.log(c(`      … and ${keys.length - PREVIEW} more (use --verbose)`, "gray"));
  }
}

function main(): void {
  const { reports } = analyze();

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        reports.map((r) => ({
          locale: r.locale,
          missing: r.missing,
          stale: r.stale,
          untranslated: r.untranslated,
          translatedCount: r.translated,
          total: r.total,
        })),
        null,
        2,
      ),
    );
  }

  let structuralProblems = 0;
  let untranslatedTotal = 0;

  if (!JSON_OUT) {
    console.log(c("\n🌍 i18n coverage — messages/ vs en.json\n", "blue"));
    const header = `${"locale".padEnd(7)}${"translated".padStart(12)}${"untranslated".padStart(14)}${"missing".padStart(9)}${"stale".padStart(7)}`;
    console.log(c(header, "bold"));
    console.log(c("─".repeat(header.length), "gray"));

    for (const r of reports) {
      const ok = r.missing.length === 0 && r.stale.length === 0 && r.untranslated.length === 0;
      const mark = ok ? c("✓", "green") : c("✗", "red");
      const pct = ((r.translated / r.total) * 100).toFixed(0);
      const utColor = r.untranslated.length > 0 ? "yellow" : "green";
      console.log(
        `${mark} ${r.locale.padEnd(5)}` +
          c(`${r.translated}/${r.total} (${pct}%)`.padStart(12), "gray") +
          c(`${r.untranslated.length}`.padStart(14), utColor) +
          c(`${r.missing.length}`.padStart(9), r.missing.length ? "red" : "gray") +
          c(`${r.stale.length}`.padStart(7), r.stale.length ? "red" : "gray"),
      );
    }
    console.log(c("─".repeat(header.length), "gray"));
  }

  for (const r of reports) {
    structuralProblems += r.missing.length + r.stale.length;
    untranslatedTotal += r.untranslated.length;
    if (JSON_OUT) continue;
    if (r.missing.length || r.stale.length || (STRICT && r.untranslated.length)) {
      console.log(c(`\n${r.locale.toUpperCase()}`, "bold"));
      printList("missing", r.missing, "red");
      printList("stale", r.stale, "red");
      if (STRICT) printList("untranslated", r.untranslated, "yellow");
    }
  }

  if (JSON_OUT) {
    process.exit(structuralProblems > 0 || (STRICT && untranslatedTotal > 0) ? 1 : 0);
  }

  console.log("");
  if (structuralProblems === 0) {
    console.log(c("✓ Structure: all locales have exact key parity with en.json", "green"));
  } else {
    console.log(c(`✗ Structure: ${structuralProblems} missing/stale keys across locales`, "red"));
  }
  if (untranslatedTotal === 0) {
    console.log(c("✓ Coverage: every translatable string is localized", "green"));
  } else {
    console.log(
      c(
        `${STRICT ? "✗" : "⚠"} Coverage: ${untranslatedTotal} untranslated (English-equal) strings remain` +
          (STRICT ? "" : "  (run with --strict to fail on these)"),
        STRICT ? "red" : "yellow",
      ),
    );
  }

  const failed = structuralProblems > 0 || (STRICT && untranslatedTotal > 0);
  process.exit(failed ? 1 : 0);
}

main();

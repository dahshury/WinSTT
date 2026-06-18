/**
 * WinSTT docs component library.
 *
 * Reusable MDX building blocks styled with the live app palette (the
 * `--brand-*` / `--surface-*` / `--fg-*` OKLch tokens defined in
 * `src/styles/app.css`). CSS-only motion (no JS animation lib in this app),
 * gated by `prefers-reduced-motion`. Registered globally in `mdx.tsx` so MDX
 * pages can use them without imports.
 *
 * Conventions:
 *  - One accent (Docker Blue `--brand-accent`) on neutral surfaces.
 *  - Recording-mode colors match the app exactly (see MODE_META).
 *  - Every interactive surface has hover + visible focus; images lazy-load
 *    with required alt text (web-interface-guidelines).
 */

import {
  AlertTriangle,
  ArrowRight,
  AudioLines,
  BookMarked,
  BrainCircuit,
  CircleCheck,
  Cpu,
  FileAudio,
  Gauge,
  History,
  Info,
  Keyboard,
  Languages,
  type LucideIcon,
  Mic,
  OctagonAlert,
  Plug,
  Radio,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Volume2,
  WandSparkles,
  Waypoints,
} from "lucide-react";
import {
  isValidElement,
  type CSSProperties,
  type ElementType,
  type ReactElement,
  type ReactNode,
} from "react";
import { withBasePath } from "@/lib/site";

// Curated icon registry so MDX can pass `icon="mic"` instead of a JSX element.
const ICONS: Record<string, LucideIcon> = {
  mic: Mic,
  waveform: AudioLines,
  realtime: AudioLines,
  brain: BrainCircuit,
  llm: BrainCircuit,
  tts: Volume2,
  volume: Volume2,
  file: FileAudio,
  dictionary: BookMarked,
  snippets: WandSparkles,
  transform: WandSparkles,
  history: History,
  compute: Cpu,
  cpu: Cpu,
  languages: Languages,
  privacy: ShieldCheck,
  shield: ShieldCheck,
  keyboard: Keyboard,
  hotkey: Keyboard,
  sparkles: Sparkles,
  cloud: Plug,
  integrations: Plug,
  wakeword: Radio,
  pipeline: Waypoints,
  speed: Gauge,
  quality: Gauge,
};

function RenderIcon({ icon }: { icon: ReactNode | undefined }) {
  if (icon == null) return null;
  if (typeof icon === "string") {
    const I = ICONS[icon] ?? Sparkles;
    return <I size={18} strokeWidth={1.75} aria-hidden="true" />;
  }
  return icon;
}

/* ------------------------------------------------------------------ */
/* Screenshot — frame a /screenshots PNG in desktop-window chrome.     */
/* ------------------------------------------------------------------ */

type Chrome = "window" | "card" | "none";
type MediaFit = "cover" | "contain";
type MediaVariant = "default" | "panel" | "section" | "strip" | "thumb";

export interface ScreenshotProps {
  /** File stem (resolved against /screenshots/<stem>.png) or an absolute path. */
  src: string;
  /** Required descriptive alt text. */
  alt: string;
  caption?: ReactNode;
  /** Window chrome style. "window" adds a titlebar strip; "card" just frames. */
  chrome?: Chrome;
  /** Max display width in px (image stays responsive below it). */
  maxWidth?: number;
  /** Window-title text shown in the chrome bar. */
  label?: string;
  /**
   * When set, crops the image to this CSS aspect-ratio (e.g. "4 / 3") via
   * object-fit: cover. Use to make a row of screenshots a uniform height while
   * each crop frames only the relevant feature. Pair with `focus`.
   */
  aspect?: string;
  /** CSS object-position for the crop (e.g. "top", "center", "50% 18%"). */
  focus?: string;
  /** Preset sizing for common docs use cases. */
  variant?: MediaVariant;
  /** How media fits when a fixed aspect ratio is applied. */
  fit?: MediaFit;
}

function resolveSrc(src: string): string {
  if (src.startsWith("http")) return src;
  if (src.startsWith("/")) return withBasePath(src);
  if (/\.(png|jpe?g|webp|gif|avif)$/i.test(src)) {
    return withBasePath(`/screenshots/${src}`);
  }
  return withBasePath(`/screenshots/${src}.png`);
}

function mediaStem(src: string): string {
  const name = src.split(/[\\/]/).pop() ?? src;
  return name.replace(/\.[^.]+$/, "");
}

function inferScreenshotPreset({
  src,
  aspect,
  focus,
  fit,
  variant = "default",
}: Pick<ScreenshotProps, "src" | "aspect" | "focus" | "fit" | "variant">) {
  const stem = mediaStem(src);
  const tallPanel =
    stem.startsWith("settings-") ||
    stem === "model-dropdown" ||
    stem === "onboarding" ||
    stem === "section-llm";

  const resolvedAspect =
    aspect ??
    (variant === "thumb"
      ? "3 / 2"
      : variant === "panel" || tallPanel
        ? "16 / 10"
        : variant === "strip" || stem === "main"
          ? "14 / 5"
          : undefined);

  return {
    aspect: resolvedAspect,
    fit: fit ?? (resolvedAspect ? "cover" : undefined),
    focus: focus ?? (tallPanel || resolvedAspect ? "top" : undefined),
    variant: variant === "default" && tallPanel ? "panel" : variant,
  };
}

function inferVideoPreset({
  src,
  aspect,
  focus,
  fit,
  variant = "default",
}: Pick<VideoProps, "src" | "aspect" | "focus" | "fit" | "variant">) {
  const stem = mediaStem(src);
  const overlay = stem.startsWith("overlay-");

  return {
    aspect: aspect ?? (overlay || variant === "strip" ? "24 / 7" : "16 / 9"),
    fit: fit ?? "contain",
    focus: focus ?? "center",
    variant: variant === "default" && overlay ? "strip" : variant,
  };
}

function mediaStyle({
  aspect,
  fit,
  focus,
}: {
  aspect?: string;
  fit?: MediaFit;
  focus?: string;
}) {
  if (!aspect) return undefined;
  return {
    "--shot-aspect": aspect,
    "--shot-fit": fit,
    "--shot-focus": focus,
  } as CSSProperties;
}

export function Screenshot({
  src,
  alt,
  caption,
  chrome = "window",
  maxWidth,
  label,
  aspect,
  focus,
  variant,
  fit,
}: ScreenshotProps) {
  const url = resolveSrc(src);
  const preset = inferScreenshotPreset({ src, aspect, focus, fit, variant });
  return (
    <figure
      className={`shot shot--${preset.variant} not-prose my-7`}
      style={maxWidth ? { maxWidth, marginInline: "auto" } : undefined}
    >
      <div className={`shot-frame shot-frame--${chrome}`}>
        {chrome === "window" ? (
          <div className="shot-bar" aria-hidden="true">
            <span className="shot-dot shot-dot--r" />
            <span className="shot-dot shot-dot--y" />
            <span className="shot-dot shot-dot--g" />
            {label ? <span className="shot-title">{label}</span> : null}
          </div>
        ) : null}
        <div
          className={`shot-media ${preset.aspect ? "shot-media--aspect" : ""}`}
          style={mediaStyle(preset)}
        >
          <img
            src={url}
            alt={alt}
            loading="lazy"
            decoding="async"
            className="shot-img"
          />
        </div>
      </div>
      {caption ? <figcaption className="shot-cap">{caption}</figcaption> : null}
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* Video — a looping clip of the REAL component, framed like Screenshot.*/
/* ------------------------------------------------------------------ */

export interface VideoProps {
  /** File stem (resolved against /demos/<stem>.webm) or an absolute path. */
  src: string;
  /** Required descriptive label (used as aria-label). */
  alt: string;
  caption?: ReactNode;
  chrome?: Chrome;
  maxWidth?: number;
  label?: string;
  aspect?: string;
  focus?: string;
  variant?: MediaVariant;
  fit?: MediaFit;
  /** Poster file stem, absolute path, or false to disable an inferred poster. */
  poster?: string | false;
}

function resolveVideo(src: string): string {
  if (src.startsWith("http")) return src;
  if (src.startsWith("/")) return withBasePath(src);
  if (/\.(webm|mp4)$/i.test(src)) return withBasePath(`/demos/${src}`);
  return withBasePath(`/demos/${src}.webm`);
}

function resolvePoster(src: string, poster: string | false | undefined) {
  if (poster === false) return undefined;
  if (typeof poster === "string") return resolveSrc(poster);

  const stem = mediaStem(src);
  if (
    stem === "main" ||
    stem === "overlay-floating" ||
    stem === "overlay-island"
  ) {
    return withBasePath(`/screenshots/${stem}.png`);
  }
  return undefined;
}

export function Video({
  src,
  alt,
  caption,
  chrome = "window",
  maxWidth,
  label,
  aspect,
  focus,
  variant,
  fit,
  poster,
}: VideoProps) {
  const url = resolveVideo(src);
  const preset = inferVideoPreset({ src, aspect, focus, fit, variant });
  const posterUrl = resolvePoster(src, poster);
  return (
    <figure
      className={`shot shot--${preset.variant} not-prose my-7`}
      style={maxWidth ? { maxWidth, marginInline: "auto" } : undefined}
    >
      <div className={`shot-frame shot-frame--${chrome}`}>
        {chrome === "window" ? (
          <div className="shot-bar" aria-hidden="true">
            <span className="shot-dot shot-dot--r" />
            <span className="shot-dot shot-dot--y" />
            <span className="shot-dot shot-dot--g" />
            {label ? <span className="shot-title">{label}</span> : null}
          </div>
        ) : null}
        <div
          className={`shot-media shot-media--video ${
            preset.aspect ? "shot-media--aspect" : ""
          }`}
          style={mediaStyle(preset)}
        >
          <video
            className="shot-img"
            src={url}
            poster={posterUrl}
            aria-label={alt}
            autoPlay
            loop
            muted
            playsInline
            preload="metadata"
            tabIndex={-1}
          />
        </div>
      </div>
      {caption ? <figcaption className="shot-cap">{caption}</figcaption> : null}
    </figure>
  );
}

export function MediaGrid({
  children,
  cols = 2,
}: {
  children: ReactNode;
  cols?: 2 | 3;
}) {
  return (
    <div className="media-grid not-prose" data-cols={cols}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hero — landing pitch with badges, CTAs and a media slot.            */
/* ------------------------------------------------------------------ */

export interface HeroProps {
  eyebrow?: string;
  title: ReactNode;
  tagline: ReactNode;
  badges?: { label: string; href?: string }[];
  ctas?: { label: string; href: string; primary?: boolean }[];
  children?: ReactNode;
}

export function Hero({
  eyebrow,
  title,
  tagline,
  badges,
  ctas,
  children,
}: HeroProps) {
  return (
    <section className="hero not-prose">
      <div className="hero-copy">
        {eyebrow ? <p className="hero-eyebrow">{eyebrow}</p> : null}
        <h1 className="hero-title text-balance">{title}</h1>
        <p className="hero-tagline text-pretty">{tagline}</p>
        {badges?.length ? (
          <div className="hero-badges">
            {badges.map((b) =>
              b.href ? (
                <a
                  key={b.label}
                  className="hero-badge"
                  href={withBasePath(b.href)}
                >
                  {b.label}
                </a>
              ) : (
                <span key={b.label} className="hero-badge">
                  {b.label}
                </span>
              ),
            )}
          </div>
        ) : null}
        {ctas?.length ? (
          <div className="hero-ctas">
            {ctas.map((c) => (
              <a
                key={c.label}
                className={`hero-cta ${c.primary ? "hero-cta--primary" : ""}`}
                href={withBasePath(c.href)}
              >
                {c.label}
                <ArrowRight size={15} aria-hidden="true" />
              </a>
            ))}
          </div>
        ) : null}
      </div>
      {children ? <div className="hero-media">{children}</div> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* BentoGrid / BentoCell — asymmetric feature grid.                    */
/* ------------------------------------------------------------------ */

export function BentoGrid({
  children,
  cols = 3,
}: {
  children: ReactNode;
  cols?: 2 | 3 | 4;
}) {
  return (
    <div className="bento not-prose" data-cols={cols}>
      {children}
    </div>
  );
}

export interface BentoCellProps {
  title: ReactNode;
  href?: string;
  icon?: ReactNode;
  span?: 1 | 2 | 3;
  accent?: string;
  children?: ReactNode;
}

export function BentoCell({
  title,
  href,
  icon,
  span = 1,
  accent,
  children,
}: BentoCellProps) {
  const Tag: ElementType = href ? "a" : "div";
  return (
    <Tag
      className="bento-cell feature-card"
      data-span={span}
      href={href ? withBasePath(href) : undefined}
      style={
        accent ? ({ "--cell-accent": accent } as CSSProperties) : undefined
      }
    >
      {icon ? (
        <span className="feature-icon bento-icon">
          <RenderIcon icon={icon} />
        </span>
      ) : null}
      <h3 className="bento-title">{title}</h3>
      {children ? <div className="bento-body">{children}</div> : null}
      {href ? (
        <ArrowRight className="bento-arrow" size={15} aria-hidden="true" />
      ) : null}
    </Tag>
  );
}

/* FeatureCard — a single linked card (alias of a 1-span bento cell). */
export function FeatureCard(props: BentoCellProps) {
  return <BentoCell {...props} />;
}

/* ------------------------------------------------------------------ */
/* ModelTable — consistent reference table (sticky head, tabular nums).*/
/* ------------------------------------------------------------------ */

export interface ModelTableProps {
  head: ReactNode[];
  rows: ReactNode[][];
  /** Right-align these column indexes (numeric columns). */
  numeric?: number[];
  dense?: boolean;
  caption?: ReactNode;
}

const EMPTY_NUMERIC_COLUMNS: number[] = [];

function nodeKey(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "empty";
  if (
    typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "bigint"
  ) {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(nodeKey).join("");
  }
  if (isValidElement(node)) {
    const element = node as ReactElement<{ children?: ReactNode }>;
    if (element.key != null) return String(element.key);
    return nodeKey(element.props.children);
  }
  return String(node);
}

function keyedNodes<T extends ReactNode>(
  nodes: readonly T[],
): { key: string; node: T }[] {
  const seen = new Map<string, number>();
  return nodes.map((node) => {
    const base = nodeKey(node);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { key: count === 0 ? base : `${base}-${count + 1}`, node };
  });
}

function keyedRows(rows: readonly ReactNode[][]): {
  key: string;
  row: ReactNode[];
}[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = row.map(nodeKey).join("|");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { key: count === 0 ? base : `${base}-${count + 1}`, row };
  });
}

export function ModelTable({
  head,
  rows,
  numeric = EMPTY_NUMERIC_COLUMNS,
  dense,
  caption,
}: ModelTableProps) {
  const num = new Set(numeric);
  const headerCells = keyedNodes(head);
  const tableRows = keyedRows(rows);
  return (
    <div className="mtable-wrap not-prose">
      <table className={`mtable ${dense ? "mtable--dense" : ""}`}>
        {caption ? <caption className="mtable-cap">{caption}</caption> : null}
        <thead>
          <tr>
            {headerCells.map(({ key, node }, i) => (
              <th key={key} className={num.has(i) ? "is-num" : ""}>
                {node}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tableRows.map(({ key, row }) => (
            <tr key={key}>
              {keyedNodes(row).map(({ key: cellKey, node: cell }, ci) => (
                <td key={cellKey} className={num.has(ci) ? "is-num" : ""}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Kbd / ShortcutLegend — keyboard chips.                              */
/* ------------------------------------------------------------------ */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Render a "LCtrl+LShift+V"-style combo into chips. */
export function Combo({ keys }: { keys: string }) {
  const parts = keys.split("+").map((k) => k.trim());
  return (
    <span className="combo">
      {parts.map((p, i) => (
        <span key={p} className="combo-part">
          {i > 0 ? (
            <span className="combo-plus" aria-hidden="true">
              +
            </span>
          ) : null}
          <Kbd>{p}</Kbd>
        </span>
      ))}
    </span>
  );
}

export interface ShortcutLegendProps {
  rows: { action: ReactNode; keys: string; note?: ReactNode }[];
}

export function ShortcutLegend({ rows }: ShortcutLegendProps) {
  return (
    <div className="legend not-prose">
      {rows.map((r) => (
        <div className="legend-row" key={`${nodeKey(r.action)}-${r.keys}`}>
          <div className="legend-keys">
            <Combo keys={r.keys} />
          </div>
          <div className="legend-action">
            <span className="legend-label">{r.action}</span>
            {r.note ? <span className="legend-note">{r.note}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* StepFlow / Step — numbered procedure with a connecting rail.        */
/* ------------------------------------------------------------------ */

export function StepFlow({ children }: { children: ReactNode }) {
  return <ol className="stepflow not-prose">{children}</ol>;
}

export function Step({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="step">
      <div className="step-marker" aria-hidden="true" />
      <div className="step-content">
        <h4 className="step-title">{title}</h4>
        {children ? <div className="step-body">{children}</div> : null}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* ModeBadge — recording-mode pill (colors match the app).            */
/* ------------------------------------------------------------------ */

const MODE_META: Record<string, { label: string; color: string }> = {
  ptt: { label: "Push-to-Talk", color: "#3b82f6" },
  toggle: { label: "Toggle", color: "#facc15" },
  listen: { label: "Listen", color: "#22c55e" },
  wakeword: { label: "Wake Word", color: "#f97316" },
};

export function ModeBadge({
  mode,
  children,
}: {
  mode: keyof typeof MODE_META | string;
  children?: ReactNode;
}) {
  const meta = MODE_META[mode] ?? {
    label: String(mode),
    color: "var(--brand-accent)",
  };
  return (
    <span
      className="mode-badge"
      style={{ "--mode-color": meta.color } as CSSProperties}
    >
      <span className="mode-dot" aria-hidden="true" />
      {children ?? meta.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* SettingRow — compact reference for one setting.                     */
/* ------------------------------------------------------------------ */

export interface SettingRowProps {
  label: ReactNode;
  settingKey?: string;
  default?: ReactNode;
  restart?: boolean;
  startupOnly?: boolean;
  children?: ReactNode;
}

export function SettingRow({
  label,
  settingKey,
  default: def,
  restart,
  startupOnly,
  children,
}: SettingRowProps) {
  return (
    <div className="setting-row not-prose">
      <div className="setting-head">
        <span className="setting-label">{label}</span>
        {def !== undefined ? (
          <span className="setting-default">
            default <code>{def}</code>
          </span>
        ) : null}
        {startupOnly ? (
          <span className="pill pill--warn">Restart server</span>
        ) : null}
        {restart && !startupOnly ? (
          <span className="pill pill--warn">Restart</span>
        ) : null}
      </div>
      {settingKey ? <code className="setting-key">{settingKey}</code> : null}
      {children ? <div className="setting-desc">{children}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Callout — info / warn / error / restart / success.                 */
/* ------------------------------------------------------------------ */

const CALLOUT_META = {
  info: { icon: Info, cls: "callout--info" },
  warn: { icon: AlertTriangle, cls: "callout--warn" },
  error: { icon: OctagonAlert, cls: "callout--error" },
  restart: { icon: RotateCw, cls: "callout--restart" },
  success: { icon: CircleCheck, cls: "callout--success" },
} as const;

export type CalloutType = keyof typeof CALLOUT_META;

export function Callout({
  type = "info",
  title,
  children,
}: {
  type?: CalloutType;
  title?: ReactNode;
  children: ReactNode;
}) {
  const meta = CALLOUT_META[type] ?? CALLOUT_META.info;
  const Icon = meta.icon;
  const fallbackTitle = type === "restart" ? "Requires a restart" : undefined;
  return (
    <div className={`callout ${meta.cls} not-prose`} role="note">
      <Icon className="callout-icon" size={17} aria-hidden="true" />
      <div className="callout-body">
        {(title ?? fallbackTitle) ? (
          <p className="callout-title">{title ?? fallbackTitle}</p>
        ) : null}
        <div className="callout-content">{children}</div>
      </div>
    </div>
  );
}

/* Stat tiles — for history/benchmark numeric highlights. */
export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="statgrid not-prose">{children}</div>;
}
export function Stat({ value, label }: { value: ReactNode; label: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

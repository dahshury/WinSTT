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
import type { CSSProperties, ElementType, ReactNode } from "react";

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

function renderIcon(icon: ReactNode | undefined): ReactNode {
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
}

function resolveSrc(src: string): string {
  if (src.startsWith("/") || src.startsWith("http")) return src;
  if (/\.(png|jpe?g|webp|gif|avif)$/i.test(src)) return `/screenshots/${src}`;
  return `/screenshots/${src}.png`;
}

export function Screenshot({
  src,
  alt,
  caption,
  chrome = "window",
  maxWidth,
  label,
}: ScreenshotProps) {
  const url = resolveSrc(src);
  return (
    <figure
      className="shot not-prose my-7"
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
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="shot-img"
        />
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
}

function resolveVideo(src: string): string {
  if (src.startsWith("/") || src.startsWith("http")) return src;
  if (/\.(webm|mp4)$/i.test(src)) return `/demos/${src}`;
  return `/demos/${src}.webm`;
}

export function Video({
  src,
  alt,
  caption,
  chrome = "window",
  maxWidth,
  label,
}: VideoProps) {
  const url = resolveVideo(src);
  return (
    <figure
      className="shot not-prose my-7"
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
        <video
          className="shot-img"
          src={url}
          aria-label={alt}
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          tabIndex={-1}
        />
      </div>
      {caption ? <figcaption className="shot-cap">{caption}</figcaption> : null}
    </figure>
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
                <a key={b.label} className="hero-badge" href={b.href}>
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
                href={c.href}
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
      href={href}
      style={
        accent ? ({ "--cell-accent": accent } as CSSProperties) : undefined
      }
    >
      {icon ? (
        <span className="feature-icon bento-icon">{renderIcon(icon)}</span>
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

export function ModelTable({
  head,
  rows,
  numeric = [],
  dense,
  caption,
}: ModelTableProps) {
  const num = new Set(numeric);
  return (
    <div className="mtable-wrap not-prose">
      <table className={`mtable ${dense ? "mtable--dense" : ""}`}>
        {caption ? <caption className="mtable-cap">{caption}</caption> : null}
        <thead>
          <tr>
            {head.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static, never-reordered header cells
              <th key={i} className={num.has(i) ? "is-num" : ""}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static, never-reordered rows
            <tr key={ri}>
              {row.map((cell, ci) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static, never-reordered cells
                <td key={ci} className={num.has(ci) ? "is-num" : ""}>
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
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed key sequence
        <span key={i} className="combo-part">
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
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static, never-reordered rows
        <div className="legend-row" key={i}>
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

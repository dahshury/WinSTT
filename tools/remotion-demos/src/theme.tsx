/**
 * Shared theme + frame-driven primitives for the WinSTT story-demo compositions.
 * Everything animates off `useCurrentFrame()` so renders are deterministic and
 * seamless. Palette mirrors the app (Docker-blue accent on blue-tinted dark).
 */
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const FPS = 30;
export const DUR = 150; // 5s loop

export const C = {
	bg: "#0a0a0f",
	surface1: "oklch(9.5% 0.015 265)",
	surface2: "oklch(12% 0.015 265)",
	surface3: "oklch(16% 0.015 265)",
	border: "oklch(30% 0.02 265)",
	accent: "#3b82f6",
	accentFg: "#04122b",
	accentSoft: "rgba(59,130,246,0.14)",
	fg: "oklch(92% 0.02 263)",
	fgMuted: "oklch(60% 0.03 258)",
	teal: "oklch(71% 0.13 245)",
	success: "#22c55e",
	error: "#f97066",
	mono: '"Geist Mono", ui-monospace, monospace',
	sans: '"Geist", system-ui, -apple-system, sans-serif',
};

export const MODE_COLOR: Record<string, string> = {
	ptt: "#3b82f6",
	toggle: "#facc15",
	listen: "#22c55e",
	wakeword: "#f97316",
};

/** Smooth 0→1 ramp over [a,b] (clamped). */
export function ramp(frame: number, a: number, b: number): number {
	return interpolate(frame, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

/** Visibility envelope: fade in over [in0,in1], hold, fade out over [out0,out1]. */
export function envelope(frame: number, in0: number, in1: number, out0: number, out1: number): number {
	if (frame < in1) return ramp(frame, in0, in1);
	if (frame > out0) return 1 - ramp(frame, out0, out1);
	return 1;
}

/** The demo canvas — dark stage + a small monospace tag, accent-tinted. */
export function Stage({ tag, children }: { tag: string; children: ReactNode }) {
	return (
		<AbsoluteFill style={{ background: C.bg, fontFamily: C.sans, color: C.fg, overflow: "hidden" }}>
			<div style={{ position: "absolute", top: 14, left: 16, fontFamily: C.mono, fontSize: 13, letterSpacing: 1, textTransform: "uppercase", color: C.accent, opacity: 0.9 }}>
				{tag}
			</div>
			<AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", padding: "34px 22px 32px" }}>
				{children}
			</AbsoluteFill>
		</AbsoluteFill>
	);
}

/** Bottom caption track — three beats across the timeline, crossfaded. */
export function Caption({ items }: { items: string[] }) {
	const f = useCurrentFrame();
	const seg = DUR / items.length;
	return (
		<div style={{ position: "absolute", bottom: 16, left: 0, right: 0, textAlign: "center", height: 18 }}>
			{items.map((c, i) => {
				const start = i * seg;
				const op = envelope(f, start + 2, start + 8, start + seg - 8, start + seg - 2);
				return (
					<div key={c} style={{ position: "absolute", left: 0, right: 0, fontSize: 14, color: C.fgMuted, opacity: op, transform: `translateY(${(1 - op) * 4}px)` }}>
						{c}
					</div>
				);
			})}
		</div>
	);
}

/** Typewriter reveal of `text` across [from, from+dur] frames, then holds. */
export function Typed({ text, from = 0, dur = 22, style }: { text: string; from?: number; dur?: number; style?: CSSProperties }) {
	const f = useCurrentFrame();
	const reveal = ramp(f, from, from + dur);
	return (
		<span style={{ whiteSpace: "nowrap", clipPath: `inset(0 ${(1 - reveal) * 100}% 0 0)`, ...style }}>{text}</span>
	);
}

/** Audio-style bars that dance off the frame clock. */
export function Bars({ count = 6, color = C.accent, height = 26, active = true, seed = 0 }: { count?: number; color?: string; height?: number; active?: boolean; seed?: number }) {
	const f = useCurrentFrame();
	return (
		<div style={{ display: "inline-flex", alignItems: "center", gap: 3, height }}>
			{Array.from({ length: count }, (_, i) => {
				const phase = (i / count) * Math.PI * 2 + seed;
				const amp = active ? 0.35 + 0.6 * Math.abs(Math.sin(f * 0.22 + phase)) * (0.7 + 0.3 * Math.sin(f * 0.5 + phase)) : 0.2;
				return <span key={i} style={{ width: 4, height: `${amp * 100}%`, borderRadius: 3, background: color }} />;
			})}
		</div>
	);
}

/** Three thinking dots bouncing. */
export function ThinkingDots({ color = C.accent }: { color?: string }) {
	const f = useCurrentFrame();
	return (
		<div style={{ display: "inline-flex", gap: 6 }}>
			{[0, 1, 2].map((i) => {
				const t = (f * 0.18 + i * 0.5) % (Math.PI * 2);
				const up = Math.max(0, Math.sin(t));
				return <span key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: color, opacity: 0.45 + 0.55 * up, transform: `translateY(${-up * 4}px)` }} />;
			})}
		</div>
	);
}

export function Keycap({ children, pressed = false }: { children: ReactNode; pressed?: boolean }) {
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				padding: "5px 11px",
				borderRadius: 8,
				fontFamily: C.mono,
				fontSize: 14,
				color: "#a9c4ff",
				background: pressed ? "rgba(59,130,246,0.3)" : C.accentSoft,
				border: `1px solid ${pressed ? C.accent : "rgba(59,130,246,0.3)"}`,
				boxShadow: pressed ? `0 0 12px ${C.accent}` : "0 2px 0 0 rgba(0,0,0,0.4)",
				transform: pressed ? "translateY(1px) scale(0.96)" : "none",
			}}
		>
			{children}
		</span>
	);
}

/** A fake text input / output box. */
export function Box({ children, style }: { children: ReactNode; style?: CSSProperties }) {
	return (
		<div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 14px", borderRadius: 10, background: C.surface3, border: `1px solid ${C.border}`, color: C.fg, fontSize: 17, boxShadow: "inset 0 1px 0 0 rgba(0,0,0,0.25)", ...style }}>
			{children}
		</div>
	);
}

/** A rounded overlay-style pill. */
export function Pill({ children, style }: { children: ReactNode; style?: CSSProperties }) {
	return (
		<div style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "8px 14px", borderRadius: 999, background: C.surface1, border: `1px solid rgba(59,130,246,0.28)`, color: C.fg, fontSize: 16, boxShadow: "0 0 26px -8px rgba(59,130,246,0.5)", ...style }}>
			{children}
		</div>
	);
}

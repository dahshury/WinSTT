import type { CSSProperties, ReactNode } from "react";
import {
	AbsoluteFill,
	Easing,
	interpolate,
	spring,
	useCurrentFrame,
} from "remotion";

export const FPS = 30;
export const DUR = 180;

export const C = {
	bg: "#08090d",
	bg2: "#0b0d13",
	surface0: "#0a0c12",
	surface1: "#0e1119",
	surface2: "#131720",
	surface3: "#191f2b",
	surface4: "#222936",
	border: "#2d3545",
	borderSoft: "rgba(255,255,255,0.08)",
	divider: "rgba(238,243,255,0.08)",
	fg: "#eef3ff",
	fg2: "#c2cad8",
	muted: "#828da3",
	dim: "#4f5a70",
	accent: "#4a83ff",
	accent2: "#7aa2ff",
	accentSoft: "rgba(74,131,255,0.12)",
	accentDim: "rgba(74,131,255,0.06)",
	teal: "#58d0ea",
	success: "#38d178",
	warning: "#f2c94c",
	orange: "#f97316",
	error: "#f97066",
	black: "#030407",
	mono: '"Geist Mono", "Cascadia Code", ui-monospace, monospace',
	sans: '"Geist", "Segoe UI", system-ui, sans-serif',
} as const;

export const MODE = {
	ptt: C.accent,
	toggle: C.warning,
	listen: C.success,
	wakeword: C.orange,
} as const;

const out = Easing.bezier(0.16, 1, 0.3, 1);
const inOut = Easing.bezier(0.45, 0, 0.55, 1);

export function ramp(frame: number, from: number, to: number, easing = out) {
	return interpolate(frame, [from, to], [0, 1], {
		easing,
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
	});
}

export function hold(
	frame: number,
	inStart: number,
	inEnd: number,
	outStart: number,
	outEnd: number,
) {
	if (frame <= inEnd) return ramp(frame, inStart, inEnd);
	if (frame >= outStart)
		return 1 - ramp(frame, outStart, outEnd, Easing.in(Easing.cubic));
	return 1;
}

export function mapRange(
	frame: number,
	input: [number, number],
	output: [number, number],
	easing = out,
) {
	return interpolate(frame, input, output, {
		easing,
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
	});
}

export function springIn(frame: number, delay = 0, stiffness = 220) {
	return spring({
		frame: frame - delay,
		fps: FPS,
		config: { damping: 19, stiffness, mass: 0.72 },
	});
}

const stageSweepBase: CSSProperties = {
	position: "absolute",
	left: 0,
	right: 0,
	height: 1,
	opacity: 0.35,
	background:
		"linear-gradient(90deg, transparent, rgba(255,255,255,0.16), transparent)",
};

const stageBadgeBase: CSSProperties = {
	position: "absolute",
	display: "inline-flex",
	alignItems: "center",
	gap: 10,
	height: 28,
	padding: "0 12px",
	borderRadius: 999,
	background: "rgba(10,12,18,0.72)",
	border: `1px solid ${C.borderSoft}`,
	boxShadow: "0 10px 30px rgba(0,0,0,0.26)",
	color: C.fg2,
	fontFamily: C.mono,
	letterSpacing: 0.4,
	textTransform: "uppercase",
};

export function Stage({
	label,
	children,
	compact = false,
}: {
	label: string;
	children: ReactNode;
	compact?: boolean;
}) {
	const frame = useCurrentFrame();
	const sweep = (frame % 120) / 120;
	return (
		<AbsoluteFill
			style={{
				background: `linear-gradient(135deg, ${C.bg} 0%, ${C.bg2} 55%, #07080c 100%)`,
				color: C.fg,
				fontFamily: C.sans,
				overflow: "hidden",
			}}
		>
			<DynamicGrid
				cellSize={48}
				lineColor="rgba(255,255,255,0.035)"
				background="transparent"
				speed={0.22}
				direction="diagonal"
			/>
			<div
				style={{
					position: "absolute",
					inset: 0,
					background:
						"linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.24) 100%)",
				}}
			/>
			<div
				style={{
					...stageSweepBase,
					top: `${18 + sweep * 45}%`,
					transform: `translateX(${mapRange(frame % 120, [0, 120], [-60, 60], inOut)}%)`,
				}}
			/>
			<div
				style={{
					...stageBadgeBase,
					top: compact ? 24 : 34,
					left: compact ? 30 : 42,
					fontSize: compact ? 12 : 13,
				}}
			>
				<span
					style={{
						width: 7,
						height: 7,
						borderRadius: 999,
						background: C.accent,
						boxShadow: `0 0 16px ${C.accent}`,
					}}
				/>
				{label}
			</div>
			<AbsoluteFill
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					padding: compact ? "72px 54px 42px" : "96px 74px 64px",
				}}
			>
				{children}
			</AbsoluteFill>
		</AbsoluteFill>
	);
}

type DynamicGridProps = {
	cellSize?: number;
	lineColor?: string;
	background?: string;
	speed?: number;
	direction?: "diagonal" | "horizontal" | "vertical";
};

function DynamicGrid({
	cellSize = 40,
	lineColor = "#27272a",
	background = "#0a0a0a",
	speed = 0.5,
	direction = "diagonal",
}: DynamicGridProps) {
	const frame = useCurrentFrame();
	const offset = (frame * speed) % cellSize;
	const tx = direction === "vertical" ? 0 : offset;
	const ty = direction === "horizontal" ? 0 : offset;

	return (
		<div
			style={{ position: "absolute", inset: 0, background, overflow: "hidden" }}
		>
			<div
				style={{
					position: "absolute",
					inset: `-${cellSize}px`,
					backgroundImage: `
            linear-gradient(to right, ${lineColor} 1px, transparent 1px),
            linear-gradient(to bottom, ${lineColor} 1px, transparent 1px)
          `,
					backgroundSize: `${cellSize}px ${cellSize}px`,
					transform: `translate(${tx}px, ${ty}px)`,
				}}
			/>
		</div>
	);
}

export function Card({
	children,
	style,
	glow = false,
}: {
	children: ReactNode;
	style?: CSSProperties;
	glow?: boolean;
}) {
	return (
		<div
			style={{
				background: "rgba(19,23,32,0.92)",
				border: `1px solid ${glow ? "rgba(74,131,255,0.32)" : C.borderSoft}`,
				borderRadius: 8,
				boxShadow: glow
					? "0 24px 80px rgba(0,0,0,0.36), 0 0 42px rgba(74,131,255,0.12), inset 0 1px 0 rgba(255,255,255,0.05)"
					: "0 22px 70px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.045)",
				...style,
			}}
		>
			{children}
		</div>
	);
}

export function AppWindow({
	title = "WinSTT",
	children,
	style,
}: {
	title?: string;
	children: ReactNode;
	style?: CSSProperties;
}) {
	return (
		<Card
			glow
			style={{
				width: 900,
				height: 512,
				overflow: "hidden",
				background: C.surface1,
				...style,
			}}
		>
			<div
				style={{
					height: 42,
					borderBottom: `1px solid ${C.divider}`,
					background: "rgba(255,255,255,0.025)",
					display: "flex",
					alignItems: "center",
					gap: 10,
					padding: "0 16px",
				}}
			>
				<Dot color={C.error} />
				<Dot color={C.warning} />
				<Dot color={C.success} />
				<span
					style={{
						marginLeft: 10,
						color: C.fg2,
						fontFamily: C.mono,
						fontSize: 13,
						letterSpacing: 0.3,
					}}
				>
					{title}
				</span>
			</div>
			<div style={{ position: "relative", height: "calc(100% - 42px)" }}>
				{children}
			</div>
		</Card>
	);
}

export function Dot({ color = C.dim }: { color?: string }) {
	return (
		<span
			style={{
				width: 10,
				height: 10,
				borderRadius: 999,
				background: color,
				boxShadow: `0 0 14px ${color}55`,
			}}
		/>
	);
}

const pillBase: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 12,
	padding: "10px 16px",
	borderRadius: 999,
	background: "rgba(10,12,18,0.88)",
	color: C.fg,
};

export function Pill({
	children,
	accent = C.accent,
	style,
}: {
	children: ReactNode;
	accent?: string;
	style?: CSSProperties;
}) {
	return (
		<div
			style={{
				...pillBase,
				border: `1px solid ${accent}55`,
				boxShadow: `0 18px 46px rgba(0,0,0,0.32), 0 0 30px ${accent}22`,
				...style,
			}}
		>
			{children}
		</div>
	);
}

const keycapBase: CSSProperties = {
	minWidth: 60,
	height: 42,
	padding: "0 14px",
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	borderRadius: 8,
	fontFamily: C.mono,
	fontWeight: 650,
	fontSize: 15,
};

export function Keycap({
	children,
	pressed = false,
	accent = C.accent,
}: {
	children: ReactNode;
	pressed?: boolean;
	accent?: string;
}) {
	return (
		<span
			style={{
				...keycapBase,
				background: pressed ? `${accent}2f` : C.surface3,
				border: `1px solid ${pressed ? `${accent}bb` : C.border}`,
				color: pressed ? C.fg : C.fg2,
				boxShadow: pressed
					? `0 0 24px ${accent}33, inset 0 1px 0 rgba(255,255,255,0.08)`
					: "0 4px 0 rgba(0,0,0,0.4)",
				transform: pressed ? "translateY(2px) scale(0.98)" : "translateY(0)",
			}}
		>
			{children}
		</span>
	);
}

export function Label({
	children,
	style,
}: {
	children: ReactNode;
	style?: CSSProperties;
}) {
	return (
		<div
			style={{
				color: C.muted,
				fontFamily: C.mono,
				fontSize: 12,
				letterSpacing: 1.2,
				textTransform: "uppercase",
				...style,
			}}
		>
			{children}
		</div>
	);
}

export function TypeText({
	text,
	from,
	duration,
	style,
}: {
	text: string;
	from: number;
	duration: number;
	style?: CSSProperties;
}) {
	const frame = useCurrentFrame();
	const chars = Math.floor(
		mapRange(frame, [from, from + duration], [0, text.length], Easing.linear),
	);
	return <span style={style}>{text.slice(0, chars)}</span>;
}

export function Bars({
	count = 9,
	accent = C.accent,
	height = 84,
	width = 11,
	active = true,
	seed = 0,
}: {
	count?: number;
	accent?: string;
	height?: number;
	width?: number;
	active?: boolean;
	seed?: number;
}) {
	const frame = useCurrentFrame();
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: width * 0.62,
				height,
			}}
		>
			{Array.from({ length: count }, (_, i) => {
				const mid = (count - 1) / 2;
				const center = 1 - Math.abs(i - mid) / Math.max(mid, 1);
				const wave = Math.abs(Math.sin(frame * 0.17 + i * 0.72 + seed));
				const amp = active ? 0.2 + wave * 0.72 * (0.68 + center * 0.32) : 0.18;
				return (
					<span
						key={i}
						style={{
							width,
							height: `${amp * 100}%`,
							borderRadius: 999,
							background: `linear-gradient(180deg, ${C.fg} 0%, ${accent} 42%, ${accent}cc 100%)`,
							opacity: 0.68 + center * 0.28,
							boxShadow: `0 0 ${8 + center * 16}px ${accent}33`,
						}}
					/>
				);
			})}
		</div>
	);
}

export function GridMeter({ accent = C.accent }: { accent?: string }) {
	const frame = useCurrentFrame();
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(12, 18px)",
				gap: 8,
				padding: 14,
				borderRadius: 8,
				background: C.surface2,
				border: `1px solid ${C.borderSoft}`,
			}}
		>
			{Array.from({ length: 60 }, (_, i) => {
				const x = i % 12;
				const y = Math.floor(i / 12);
				const v = Math.sin(frame * 0.12 + x * 0.75 + y * 0.55);
				const active = v > 0.1 + y * 0.05;
				return (
					<span
						key={i}
						style={{
							width: 18,
							height: 18,
							borderRadius: 5,
							background: active ? accent : "rgba(255,255,255,0.06)",
							opacity: active ? 0.42 + Math.max(0, v) * 0.58 : 1,
							boxShadow: active ? `0 0 18px ${accent}44` : "none",
						}}
					/>
				);
			})}
		</div>
	);
}

export function WaveMeter({ accent = C.accent }: { accent?: string }) {
	const frame = useCurrentFrame();
	const points = Array.from({ length: 58 }, (_, i) => {
		const x = (i / 57) * 520;
		const y =
			88 +
			Math.sin(i * 0.46 + frame * 0.15) * 30 +
			Math.sin(i * 0.18 + frame * 0.07) * 13;
		return `${x},${y}`;
	}).join(" ");
	return (
		<svg width="560" height="176" viewBox="0 0 560 176">
			<polyline
				points={points}
				fill="none"
				stroke={accent}
				strokeWidth="8"
				strokeLinecap="round"
				strokeLinejoin="round"
				opacity="0.9"
			/>
			<polyline
				points={points}
				fill="none"
				stroke={C.fg}
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				opacity="0.28"
			/>
		</svg>
	);
}

export function RadialMeter({ accent = C.accent }: { accent?: string }) {
	const frame = useCurrentFrame();
	const cx = 180;
	const cy = 180;
	return (
		<svg width="360" height="360" viewBox="0 0 360 360">
			<circle cx={cx} cy={cy} r="72" fill={C.surface2} stroke={C.borderSoft} />
			{Array.from({ length: 42 }, (_, i) => {
				const a = (i / 42) * Math.PI * 2 - Math.PI / 2;
				const amp = 24 + Math.abs(Math.sin(frame * 0.16 + i * 0.45)) * 58;
				const r1 = 94;
				const r2 = r1 + amp;
				return (
					<line
						key={i}
						x1={cx + Math.cos(a) * r1}
						y1={cy + Math.sin(a) * r1}
						x2={cx + Math.cos(a) * r2}
						y2={cy + Math.sin(a) * r2}
						stroke={accent}
						strokeWidth="6"
						strokeLinecap="round"
						opacity={0.34 + amp / 110}
					/>
				);
			})}
			<text
				x={cx}
				y={cy + 6}
				textAnchor="middle"
				fill={C.fg}
				fontSize="18"
				fontFamily={C.mono}
			>
				LIVE
			</text>
		</svg>
	);
}

export function AuraMeter({ accent = C.accent }: { accent?: string }) {
	const frame = useCurrentFrame();
	const pulse = 0.5 + Math.sin(frame * 0.12) * 0.5;
	return (
		<div
			style={{
				width: 310,
				height: 220,
				display: "grid",
				placeItems: "center",
			}}
		>
			<div
				style={{
					width: 118 + pulse * 82,
					height: 118 + pulse * 72,
					borderRadius: "44% 56% 52% 48%",
					background: `radial-gradient(circle at 42% 38%, ${C.fg}66, ${accent}99 38%, ${accent}22 67%, transparent 72%)`,
					filter: "blur(1px)",
					boxShadow: `0 0 ${50 + pulse * 50}px ${accent}55`,
					opacity: 0.74,
				}}
			/>
		</div>
	);
}

const progressBarBase: CSSProperties = {
	position: "absolute",
	top: 18,
	height: 4,
	borderRadius: 999,
};

const progressNodeBase: CSSProperties = {
	borderRadius: 999,
	display: "grid",
	placeItems: "center",
	fontFamily: C.mono,
	fontWeight: 800,
};

const progressLabelBase: CSSProperties = {
	position: "absolute",
	top: 52,
	left: -42,
	width: 122,
	textAlign: "center",
	fontSize: 14,
	lineHeight: 1.2,
};

export function ProgressSteps({
	steps,
	activeColor = C.accent,
	style,
}: {
	steps: string[];
	activeColor?: string;
	style?: CSSProperties;
}) {
	const frame = useCurrentFrame();
	const gap = 124;
	const node = 38;
	return (
		<div
			style={{
				position: "relative",
				height: 92,
				width: gap * (steps.length - 1) + node,
				...style,
			}}
		>
			<div
				style={{
					position: "absolute",
					left: node / 2,
					right: node / 2,
					top: 18,
					height: 4,
					borderRadius: 999,
					background: C.surface4,
				}}
			/>
			<div
				style={{
					...progressBarBase,
					left: node / 2,
					background: activeColor,
					width: `${mapRange(frame, [12, 138], [0, 100], inOut)}%`,
					maxWidth: gap * (steps.length - 1),
					boxShadow: `0 0 20px ${activeColor}55`,
				}}
			/>
			{steps.map((step, i) => {
				const p = ramp(frame, i * 30 + 8, i * 30 + 22);
				const s = 0.84 + springIn(frame, i * 30 + 6, 180) * 0.16;
				return (
					<div
						key={step}
						style={{ position: "absolute", left: i * gap, top: 0, width: node }}
					>
						<div
							style={{
								...progressNodeBase,
								width: node,
								height: node,
								background: p > 0.5 ? activeColor : C.surface3,
								border: `1px solid ${p > 0.5 ? activeColor : C.border}`,
								color: p > 0.5 ? C.black : C.fg2,
								transform: `scale(${s})`,
								boxShadow: p > 0.5 ? `0 0 26px ${activeColor}44` : "none",
							}}
						>
							{p > 0.75 ? "OK" : i + 1}
						</div>
						<div
							style={{
								...progressLabelBase,
								color: p > 0.5 ? C.fg : C.muted,
							}}
						>
							{step}
						</div>
					</div>
				);
			})}
		</div>
	);
}

const miniFooterStyle: CSSProperties = {
	height: 54,
	borderTop: `1px solid ${C.divider}`,
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	padding: "0 20px",
	color: C.muted,
	fontFamily: C.mono,
	fontSize: 12,
};

export function MiniFooter({
	hotkey = "LCtrl+LMeta",
	mic = "Default mic",
	model = "tiny",
}: {
	hotkey?: string;
	mic?: string;
	model?: string;
}) {
	return (
		<div style={miniFooterStyle}>
			<span>Hotkey {hotkey}</span>
			<span>{mic}</span>
			<span>Model {model}</span>
		</div>
	);
}

const cursorRingBase: CSSProperties = {
	position: "absolute",
	left: -16,
	top: -16,
	width: 44,
	height: 44,
	borderRadius: 999,
	border: `2px solid ${C.accent}`,
};

export function MockCursor({
	from,
	to,
	start = 20,
	end = 92,
	clickAt,
}: {
	from: [number, number];
	to: [number, number];
	start?: number;
	end?: number;
	clickAt?: number;
}) {
	const frame = useCurrentFrame();
	const t = ramp(frame, start, end, inOut);
	const x = interpolate(t, [0, 1], [from[0], to[0]]);
	const y = interpolate(t, [0, 1], [from[1], to[1]]);
	const click =
		clickAt == null
			? 0
			: hold(frame, clickAt, clickAt + 4, clickAt + 18, clickAt + 28);
	return (
		<div
			style={{
				position: "absolute",
				left: x,
				top: y,
				width: 28,
				height: 28,
				transform: `translate(-2px, -2px) scale(${1 - click * 0.08})`,
				zIndex: 40,
			}}
		>
			{click > 0 ? (
				<div
					style={{
						...cursorRingBase,
						opacity: 1 - click,
						transform: `scale(${0.55 + click * 1.2})`,
					}}
				/>
			) : null}
			<svg width="28" height="28" viewBox="0 0 28 28">
				<path
					d="M5 3l16 11-8 2-4 8z"
					fill={C.fg}
					stroke={C.black}
					strokeWidth="1.4"
				/>
			</svg>
		</div>
	);
}

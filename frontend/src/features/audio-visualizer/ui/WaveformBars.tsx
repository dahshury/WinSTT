"use client";

import { memo, useCallback, useEffect, useRef } from "react";
import { useVisualizerStore } from "../model/visualizer-store";

/* ── Tuning constants ─────────────────────────────────────────────── */

/** Idle amplitude when recording but no speech (subtle breathing). */
const IDLE_AMP = 0.06;
/** Maximum amplitude when audio level is at 1.0. */
const SPEECH_AMP = 0.32;
/** Extra amplitude added by a sentence-landing pulse. */
const PULSE_EXTRA_AMP = 0.08;
/** How quickly the smoothed amplitude tracks its target (0-1). */
const AMP_SMOOTHING = 0.08;
/** Max stroke opacity for the accent wave (active). */
const STROKE_ALPHA_ACTIVE = 0.25;
/** Max stroke opacity for the idle wave (recording but no speech). */
const STROKE_ALPHA_IDLE = 0.06;
/** Fill peak alpha (active). */
const FILL_ALPHA_ACTIVE = 0.04;
/** RGB for active color (bright blue). */
const ACCENT = "88, 166, 255";
/** RGB for idle color (blue-tinted white). */
const IDLE_COLOR = "160, 170, 190";

/** How quickly smoothedActivity interpolates toward its target (0-1 per frame). */
const ACTIVITY_SMOOTHING = 0.06;
/** audioLevel threshold to consider "active". */
const ACTIVITY_THRESHOLD = 0.02;

/* ── Wave layers: each is a sine wave with its own speed & phase ── */

interface WaveLayer {
	/** Frequency multiplier (higher = more oscillations across width). */
	freq: number;
	/** Phase offset. */
	phase: number;
	/** Time speed (rad/s). */
	speed: number;
	/** Amplitude weight (summed then normalized). */
	weight: number;
}

const WAVE_LAYERS: WaveLayer[] = [
	{ freq: 1.2, speed: 0.8, weight: 1.0, phase: 0 },
	{ freq: 2.5, speed: 1.3, weight: 0.5, phase: 1.2 },
	{ freq: 0.6, speed: 0.4, weight: 0.7, phase: 2.8 },
	{ freq: 3.8, speed: 1.8, weight: 0.25, phase: 0.5 },
];

const TOTAL_WEIGHT = WAVE_LAYERS.reduce((s, l) => s + l.weight, 0);

/** Number of points along the x-axis to sample. */
const RESOLUTION = 120;

/* ── Rendering helpers ────────────────────────────────────────────── */

function computeWaveY(t: number, time: number, amplitude: number, midY: number): number {
	let sum = 0;
	for (const layer of WAVE_LAYERS) {
		sum += Math.sin(t * layer.freq * Math.PI * 2 + time * layer.speed + layer.phase) * layer.weight;
	}
	const normalized = sum / TOTAL_WEIGHT;
	const edgeFade = Math.sin(t * Math.PI);
	return midY - normalized * amplitude * midY * edgeFade;
}

function buildWavePoints(
	w: number,
	h: number,
	time: number,
	amplitude: number
): [x: number, y: number][] {
	const midY = h / 2;
	const points: [number, number][] = [];
	for (let i = 0; i <= RESOLUTION; i++) {
		const t = i / RESOLUTION;
		points.push([t * w, computeWaveY(t, time, amplitude, midY)]);
	}
	return points;
}

function tracePath(ctx: CanvasRenderingContext2D, points: [number, number][]) {
	for (let i = 0; i < points.length; i++) {
		const pt = points[i]!;
		if (i === 0) {
			ctx.moveTo(pt[0], pt[1]);
		} else {
			ctx.lineTo(pt[0], pt[1]);
		}
	}
}

function drawWavePath(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	time: number,
	amplitude: number,
	mirror: boolean
) {
	const midY = h / 2;
	const points = buildWavePoints(w, h, time, amplitude);
	ctx.beginPath();
	if (mirror) {
		tracePath(
			ctx,
			points.map(([x, y]) => [x, midY + (midY - y)])
		);
	} else {
		tracePath(ctx, points);
	}
}

function drawFilledRegion(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	time: number,
	amplitude: number,
	alpha: number,
	color: string
) {
	const midY = h / 2;
	const points = buildWavePoints(w, h, time, amplitude);

	ctx.beginPath();
	tracePath(ctx, points);
	// Trace mirrored path in reverse to close the filled region
	for (let i = points.length - 1; i >= 0; i--) {
		const pt = points[i]!;
		ctx.lineTo(pt[0], midY + (midY - pt[1]));
	}
	ctx.closePath();

	const g = ctx.createLinearGradient(0, midY - h * amplitude * 0.5, 0, midY + h * amplitude * 0.5);
	g.addColorStop(0, `rgba(${color}, 0)`);
	g.addColorStop(0.4, `rgba(${color}, ${alpha})`);
	g.addColorStop(0.5, `rgba(${color}, ${alpha * 1.2})`);
	g.addColorStop(0.6, `rgba(${color}, ${alpha})`);
	g.addColorStop(1, `rgba(${color}, 0)`);
	ctx.fillStyle = g;
	ctx.fill();
}

function makeStrokeGradient(
	ctx: CanvasRenderingContext2D,
	w: number,
	alpha: number,
	color: string
) {
	const g = ctx.createLinearGradient(0, 0, w, 0);
	g.addColorStop(0, `rgba(${color}, 0)`);
	g.addColorStop(0.2, `rgba(${color}, ${alpha})`);
	g.addColorStop(0.5, `rgba(${color}, ${alpha})`);
	g.addColorStop(0.8, `rgba(${color}, ${alpha})`);
	g.addColorStop(1, `rgba(${color}, 0)`);
	return g;
}

/** Linearly interpolate between two "r, g, b" strings. */
function lerpColor(a: string, b: string, t: number): string {
	const [ar = 0, ag = 0, ab = 0] = a.split(",").map(Number);
	const [br = 0, bg = 0, bb = 0] = b.split(",").map(Number);
	const r = Math.round(ar + (br - ar) * t);
	const g = Math.round(ag + (bg - ag) * t);
	const bl = Math.round(ab + (bb - ab) * t);
	return `${r}, ${g}, ${bl}`;
}

interface RenderParams {
	color: string;
	fillAlpha: number;
	lineWidthMain: number;
	lineWidthMirror: number;
	strokeAlpha: number;
	targetAmp: number;
}

function computeTargetAmp(
	isRecording: boolean,
	isSpeaking: boolean,
	audioLevel: number,
	sentencePulse: number
): number {
	if (!(isRecording || audioLevel > 0)) {
		return 0;
	}
	const speechContrib = audioLevel * SPEECH_AMP;
	const vadBoost = isSpeaking ? 0.04 : 0;
	const pulseContrib = sentencePulse * PULSE_EXTRA_AMP;
	return IDLE_AMP + speechContrib + vadBoost + pulseContrib;
}

function computeRenderParams(
	isRecording: boolean,
	isSpeaking: boolean,
	audioLevel: number,
	sentencePulse: number,
	smoothedActivity: number
): RenderParams {
	const targetAmp = computeTargetAmp(isRecording, isSpeaking, audioLevel, sentencePulse);
	// Smooth color/opacity interpolation based on smoothedActivity
	const color = lerpColor(IDLE_COLOR, ACCENT, smoothedActivity);
	const strokeAlpha =
		STROKE_ALPHA_IDLE + (STROKE_ALPHA_ACTIVE - STROKE_ALPHA_IDLE) * smoothedActivity;
	const fillAlpha =
		0.005 +
		(FILL_ALPHA_ACTIVE - 0.005) * smoothedActivity * Math.min(1, audioLevel + sentencePulse * 0.5);
	const lineWidthMain = 0.75 + 0.75 * smoothedActivity;
	const lineWidthMirror = 0.5 + 0.5 * smoothedActivity;

	return { targetAmp, color, strokeAlpha, fillAlpha, lineWidthMain, lineWidthMirror };
}

function getDpr(): number {
	return window.devicePixelRatio || 1;
}

function ensureCanvasSize(canvas: HTMLCanvasElement, w: number, h: number, dpr: number): void {
	const cw = Math.round(w * dpr);
	const ch = Math.round(h * dpr);
	if (canvas.width !== cw || canvas.height !== ch) {
		canvas.width = cw;
		canvas.height = ch;
	}
}

interface CanvasMetrics {
	ctx: CanvasRenderingContext2D;
	dpr: number;
	h: number;
	w: number;
}

function getCanvasMetrics(
	canvas: HTMLCanvasElement,
	container: HTMLDivElement
): CanvasMetrics | null {
	const rect = container.getBoundingClientRect();
	const dpr = getDpr();
	const w = rect.width;
	const h = rect.height;
	ensureCanvasSize(canvas, w, h, dpr);
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	return { ctx, w, h, dpr };
}

function hasAudioInput(isRecording: boolean, audioLevel: number): boolean {
	return isRecording || audioLevel > 0;
}

function isAudioActive(isSpeaking: boolean, audioLevel: number): boolean {
	return isSpeaking || audioLevel > ACTIVITY_THRESHOLD;
}

function computeActivityTarget(
	isRecording: boolean,
	isSpeaking: boolean,
	audioLevel: number
): number {
	return hasAudioInput(isRecording, audioLevel) && isAudioActive(isSpeaking, audioLevel) ? 1 : 0;
}

function drawBaseline(ctx: CanvasRenderingContext2D, w: number, h: number): void {
	const midY = h / 2;
	ctx.beginPath();
	ctx.moveTo(0, midY);
	ctx.lineTo(w, midY);
	ctx.strokeStyle = makeStrokeGradient(ctx, w, STROKE_ALPHA_IDLE, IDLE_COLOR);
	ctx.lineWidth = 1;
	ctx.stroke();
}

function drawFrame(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	amp: number,
	params: RenderParams
) {
	const time = performance.now() / 1000;
	const { color, strokeAlpha, fillAlpha, lineWidthMain, lineWidthMirror } = params;

	drawFilledRegion(ctx, w, h, time, amp, fillAlpha, color);

	ctx.strokeStyle = makeStrokeGradient(ctx, w, strokeAlpha, color);
	ctx.lineWidth = lineWidthMain;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	drawWavePath(ctx, w, h, time, amp, false);
	ctx.stroke();

	ctx.strokeStyle = makeStrokeGradient(ctx, w, strokeAlpha * 0.4, color);
	ctx.lineWidth = lineWidthMirror;
	drawWavePath(ctx, w, h, time, amp, true);
	ctx.stroke();
}

/* ── Component ────────────────────────────────────────────────────── */

export const WaveformBars = memo(function WaveformBars() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const rafRef = useRef(0);
	const smoothedAmpRef = useRef(0);
	const smoothedActivityRef = useRef(0);

	const renderFrame = useCallback((metrics: CanvasMetrics) => {
		const { ctx, w, h, dpr } = metrics;
		const { isRecording, isSpeaking, audioLevel, sentencePulse } = useVisualizerStore.getState();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		const activityTarget = computeActivityTarget(isRecording, isSpeaking, audioLevel);
		const prevActivity = smoothedActivityRef.current;
		const activity = prevActivity + (activityTarget - prevActivity) * ACTIVITY_SMOOTHING;
		smoothedActivityRef.current = activity;

		const params = computeRenderParams(
			isRecording,
			isSpeaking,
			audioLevel,
			sentencePulse,
			activity
		);

		const prevAmp = smoothedAmpRef.current;
		const amp = prevAmp + (params.targetAmp - prevAmp) * AMP_SMOOTHING;
		smoothedAmpRef.current = amp;

		drawBaseline(ctx, w, h);
		if (amp >= 0.001) {
			drawFrame(ctx, w, h, amp, params);
		}
	}, []);

	const render = useCallback(() => {
		const canvas = canvasRef.current;
		const container = containerRef.current;
		if (!(canvas && container)) {
			return;
		}
		const metrics = getCanvasMetrics(canvas, container);
		if (metrics) {
			renderFrame(metrics);
		}
		rafRef.current = requestAnimationFrame(render);
	}, [renderFrame]);

	useEffect(() => {
		rafRef.current = requestAnimationFrame(render);
		return () => cancelAnimationFrame(rafRef.current);
	}, [render]);

	return (
		<div aria-hidden="true" className="absolute inset-0" ref={containerRef}>
			<canvas className="h-full w-full" ref={canvasRef} style={{ imageRendering: "auto" }} />
		</div>
	);
});

// Test-only exports — pure helpers extracted from the render loop. Not part
// of the public surface; consumers should use the WaveformBars component.
export const __waveform_test_helpers__ = {
	computeTargetAmp,
	computeRenderParams,
	computeActivityTarget,
	hasAudioInput,
	isAudioActive,
	getDpr,
	ensureCanvasSize,
	getCanvasMetrics,
	drawBaseline,
	tracePath,
};

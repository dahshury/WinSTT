"use client";

import { useCallback, useEffect, useRef } from "react";
import { useVisualizerStore } from "../model/visualizer-store";

const DPR = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

interface Point {
	x: number;
	y: number;
}

/** Catmull-Rom spline through points, returning a smooth path. */
function drawSmoothCurve(ctx: CanvasRenderingContext2D, points: Point[], tension = 0.3) {
	if (points.length < 2) {
		return;
	}
	const first = points[0];
	if (!first) {
		return;
	}
	ctx.moveTo(first.x, first.y);

	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[i - 1] ?? points[i]!;
		const p1 = points[i]!;
		const p2 = points[i + 1]!;
		const p3 = points[i + 2] ?? p2;

		const cp1x = p1.x + ((p2.x - p0.x) * tension) / 3;
		const cp1y = p1.y + ((p2.y - p0.y) * tension) / 3;
		const cp2x = p2.x - ((p3.x - p1.x) * tension) / 3;
		const cp2y = p2.y - ((p3.y - p1.y) * tension) / 3;

		ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
	}
}

function buildPoints(frequencyData: Uint8Array, w: number, h: number) {
	const midY = h / 2;
	const maxAmplitude = h * 0.38;
	const len = frequencyData.length;
	const points: Point[] = [];
	const mirror: Point[] = [];

	for (let i = 0; i < len; i++) {
		const t = i / (len - 1);
		const x = t * w;
		const val = (frequencyData[i] ?? 0) / 255;
		const edgeFade = Math.sin(t * Math.PI);
		const amplitude = val * maxAmplitude * edgeFade;

		points.push({ x, y: midY - amplitude });
		mirror.push({ x, y: midY + amplitude });
	}

	return { points, mirror, midY, maxAmplitude };
}

function makeHorizontalGradient(ctx: CanvasRenderingContext2D, w: number, active: boolean) {
	const g = ctx.createLinearGradient(0, 0, w, 0);
	const a = active ? 0.7 : 0.06;
	const peak = active ? 1.0 : 0.1;
	const color = active ? "245, 158, 11" : "255, 255, 255";
	g.addColorStop(0, `rgba(${color}, 0.0)`);
	g.addColorStop(0.15, `rgba(${color}, ${a})`);
	g.addColorStop(0.5, `rgba(${color}, ${peak})`);
	g.addColorStop(0.85, `rgba(${color}, ${a})`);
	g.addColorStop(1, `rgba(${color}, 0.0)`);
	return g;
}

function drawGlow(ctx: CanvasRenderingContext2D, points: Point[], mirror: Point[]) {
	ctx.save();
	ctx.shadowColor = "rgba(245, 158, 11, 0.4)";
	ctx.shadowBlur = 24;
	ctx.strokeStyle = "rgba(245, 158, 11, 0.3)";
	ctx.lineWidth = 4;
	ctx.beginPath();
	drawSmoothCurve(ctx, points);
	ctx.stroke();
	ctx.beginPath();
	drawSmoothCurve(ctx, mirror);
	ctx.stroke();
	ctx.restore();
}

function drawFill(
	ctx: CanvasRenderingContext2D,
	points: Point[],
	mirror: Point[],
	midY: number,
	maxAmp: number,
	active: boolean
) {
	const g = ctx.createLinearGradient(0, midY - maxAmp, 0, midY + maxAmp);
	if (active) {
		g.addColorStop(0, "rgba(245, 158, 11, 0.0)");
		g.addColorStop(0.3, "rgba(245, 158, 11, 0.08)");
		g.addColorStop(0.5, "rgba(245, 158, 11, 0.12)");
		g.addColorStop(0.7, "rgba(245, 158, 11, 0.08)");
		g.addColorStop(1, "rgba(245, 158, 11, 0.0)");
	} else {
		g.addColorStop(0, "rgba(255, 255, 255, 0.0)");
		g.addColorStop(0.5, "rgba(255, 255, 255, 0.015)");
		g.addColorStop(1, "rgba(255, 255, 255, 0.0)");
	}

	ctx.beginPath();
	drawSmoothCurve(ctx, points);
	for (let i = mirror.length - 1; i >= 0; i--) {
		ctx.lineTo(mirror[i]!.x, mirror[i]!.y);
	}
	ctx.closePath();
	ctx.fillStyle = g;
	ctx.fill();
}

function drawStrokes(
	ctx: CanvasRenderingContext2D,
	points: Point[],
	mirror: Point[],
	w: number,
	midY: number,
	active: boolean
) {
	// Top waveform
	ctx.strokeStyle = makeHorizontalGradient(ctx, w, active);
	ctx.lineWidth = active ? 2 : 1;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	ctx.beginPath();
	drawSmoothCurve(ctx, points);
	ctx.stroke();

	// Mirror (dimmer)
	const mg = ctx.createLinearGradient(0, 0, w, 0);
	const mAlpha = active ? 0.3 : 0.04;
	const mPeak = active ? 0.5 : 0.04;
	const color = active ? "245, 158, 11" : "255, 255, 255";
	mg.addColorStop(0, `rgba(${color}, 0.0)`);
	mg.addColorStop(0.15, `rgba(${color}, ${mAlpha})`);
	mg.addColorStop(0.5, `rgba(${color}, ${mPeak})`);
	mg.addColorStop(0.85, `rgba(${color}, ${mAlpha})`);
	mg.addColorStop(1, `rgba(${color}, 0.0)`);

	ctx.strokeStyle = mg;
	ctx.lineWidth = active ? 1.5 : 0.5;
	ctx.beginPath();
	drawSmoothCurve(ctx, mirror);
	ctx.stroke();

	// Subtle center baseline
	ctx.strokeStyle = active ? "rgba(245, 158, 11, 0.1)" : "rgba(255, 255, 255, 0.03)";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(0, midY);
	ctx.lineTo(w, midY);
	ctx.stroke();
}

export function WaveformBars() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const rafRef = useRef(0);

	const render = useCallback(() => {
		const canvas = canvasRef.current;
		const container = containerRef.current;
		if (!(canvas && container)) {
			return;
		}

		const { frequencyData, isActive } = useVisualizerStore.getState();
		const rect = container.getBoundingClientRect();
		const w = rect.width;
		const h = rect.height;

		const cw = Math.round(w * DPR);
		const ch = Math.round(h * DPR);
		if (canvas.width !== cw || canvas.height !== ch) {
			canvas.width = cw;
			canvas.height = ch;
		}

		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return;
		}

		ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
		ctx.clearRect(0, 0, w, h);

		const { points, mirror, midY, maxAmplitude } = buildPoints(frequencyData, w, h);

		if (isActive) {
			drawGlow(ctx, points, mirror);
		}
		drawFill(ctx, points, mirror, midY, maxAmplitude, isActive);
		drawStrokes(ctx, points, mirror, w, midY, isActive);

		rafRef.current = requestAnimationFrame(render);
	}, []);

	useEffect(() => {
		rafRef.current = requestAnimationFrame(render);
		return () => cancelAnimationFrame(rafRef.current);
	}, [render]);

	return (
		<div className="absolute inset-0" ref={containerRef}>
			<canvas className="h-full w-full" ref={canvasRef} style={{ imageRendering: "auto" }} />
		</div>
	);
}

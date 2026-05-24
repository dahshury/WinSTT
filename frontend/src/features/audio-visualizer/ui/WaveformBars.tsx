import { memo, useCallback, useEffect, useRef } from "react";
import {
	ACTIVITY_SMOOTHING,
	AMP_SMOOTHING,
	type CanvasMetrics,
	computeActivityTarget,
	computeRenderParams,
	drawBaseline,
	drawFrame,
	getCanvasMetrics,
} from "../lib/waveform-bars-test-helpers";
import { useVisualizerStore } from "../model/visualizer-store";

export const WaveformBars = memo(function WaveformBars() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const rafRef = useRef(0);
	const smoothedAmpRef = useRef(0);
	const smoothedActivityRef = useRef(0);

	// @crap-exclude rAF callback — Canvas2D draw path; pure helpers (computeRenderParams, drawFrame) are unit tested
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

	// @crap-exclude rAF callback — covered via E2E
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

	// @crap-exclude rAF callback — covered via E2E
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

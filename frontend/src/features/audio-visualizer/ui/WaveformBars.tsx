import { useEffect, useRef } from "react";
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

export function WaveformBars() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const rafRef = useRef(0);
	const smoothedAmpRef = useRef(0);
	const smoothedActivityRef = useRef(0);

	// @crap-exclude rAF callback — covered via E2E
	useEffect(() => {
		// @crap-exclude rAF callback — Canvas2D draw path; pure helpers (computeRenderParams, drawFrame) are unit tested
		const renderFrame = (metrics: CanvasMetrics) => {
			const { ctx, w, h, dpr } = metrics;
			const { isRecording, isSpeaking, audioLevel, sentencePulse } =
				useVisualizerStore.getState();
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, w, h);

			const activityTarget = computeActivityTarget(isRecording, isSpeaking, audioLevel);
			const prevActivity = smoothedActivityRef.current;
			// When the session ends (natural stop, user cancel, or server abort)
			// `isRecording` flips to false and `audioLevel` is reset to 0 by
			// useVisualizerSync. Smoothing the amp / activity refs toward 0 at
			// the per-frame rate gives a ~0.5 s visual fade, which the user reads
			// as "the cancel took half a second to register." Snap both refs to
			// 0 the instant recording is no longer active so the bars and color
			// transition disappear on the same frame as the click.
			const activity = isRecording
				? prevActivity + (activityTarget - prevActivity) * ACTIVITY_SMOOTHING
				: 0;
			smoothedActivityRef.current = activity;

			const params = computeRenderParams(
				isRecording,
				isSpeaking,
				audioLevel,
				sentencePulse,
				activity
			);

			const prevAmp = smoothedAmpRef.current;
			const amp = isRecording ? prevAmp + (params.targetAmp - prevAmp) * AMP_SMOOTHING : 0;
			smoothedAmpRef.current = amp;

			drawBaseline(ctx, w, h);
			if (amp >= 0.001) {
				drawFrame(ctx, w, h, amp, params);
			}
		};

		const render = () => {
			const canvas = canvasRef.current;
			const container = containerRef.current;
			if (!(canvas && container)) {
				rafRef.current = requestAnimationFrame(render);
				return;
			}
			const metrics = getCanvasMetrics(canvas, container);
			if (metrics) {
				renderFrame(metrics);
			}
			rafRef.current = requestAnimationFrame(render);
		};

		rafRef.current = requestAnimationFrame(render);
		return () => cancelAnimationFrame(rafRef.current);
	}, []);

	return (
		<div aria-hidden="true" className="absolute inset-0" ref={containerRef}>
			<canvas className="h-full w-full" ref={canvasRef} style={{ imageRendering: "auto" }} />
		</div>
	);
}

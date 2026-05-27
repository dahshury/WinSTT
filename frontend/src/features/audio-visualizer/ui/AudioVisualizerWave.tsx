import { cva } from "class-variance-authority";
import { type ComponentProps, useEffect, useRef } from "react";
import { cn } from "@/shared/lib/cn";
import type { VisualizerSize } from "../lib/audio-visualizer";
import { DEFAULT_VISUALIZER_COLOR as DEFAULT_COLOR, hexToRgb } from "../lib/hex-to-rgb";
import { useAgentState } from "../lib/use-agent-state";
import { useWaveAnimator } from "../lib/use-wave-animator";
import { ReactShaderToy, type Uniforms } from "./ReactShaderToy";

const waveShaderSource = `
const float TAU = 6.28318530718;

vec2 randFibo(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.xx + p.yx) * p.xy);
}

float luma(vec3 color) {
  return dot(color, vec3(0.299, 0.587, 0.114));
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float bellCurve(float distanceFromCenter, float maxDistance) {
  float normalizedDistance = distanceFromCenter / maxDistance;
  return pow(cos(normalizedDistance * (3.14159265359 / 4.0)), 16.0);
}

float oscilloscopeWave(float x, float centerX, float time) {
  float relativeX = x - centerX;
  float maxDistance = centerX;
  float distanceFromCenter = abs(relativeX);
  float bell = bellCurve(distanceFromCenter, maxDistance);
  float wave = sin(relativeX * uFrequency + time * uSpeed) * uAmplitude * bell;
  return wave;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 pos = uv - 0.5;
  float centerX = 0.5;
  float centerY = 0.5;
  float x = uv.x;
  float y = uv.y;
  float pixelSize = 2.0 / (iResolution.x + iResolution.y);
  float lineWidthUV = uLineWidth * pixelSize;
  float smoothingUV = uSmoothing * pixelSize;
  const int NUM_SAMPLES = 50;
  float minDist = 1000.0;
  float sampleRange = 0.02;
  for(int i = 0; i < NUM_SAMPLES; i++) {
    float offset = (float(i) / float(NUM_SAMPLES - 1) - 0.5) * sampleRange;
    float sampleX = x + offset;
    float waveY = centerY + oscilloscopeWave(sampleX, centerX, iTime);
    vec2 wavePoint = vec2(sampleX, waveY);
    vec2 currentPoint = vec2(x, y);
    float dist = distance(currentPoint, wavePoint);
    minDist = min(minDist, dist);
  }
  float line = smoothstep(lineWidthUV + smoothingUV, lineWidthUV - smoothingUV, minDist);
  vec3 color = uColor;
  if(abs(uColorShift) > 0.01) {
    float centerBandHalfWidth = 0.2;
    float edgeBandWidth = 0.5;
    float distanceFromCenter = abs(x - centerX);
    float edgeFactor = clamp((distanceFromCenter - centerBandHalfWidth) / edgeBandWidth, 0.0, 1.0);
    vec3 hsv = rgb2hsv(color);
    hsv.x = fract(hsv.x + edgeFactor * uColorShift * 0.3);
    color = hsv2rgb(hsv);
  }
  color *= line;
  float alpha = line * uMix;
  fragColor = vec4(color * uMix, alpha);
}`;

const waveVariants = cva(["aspect-square"], {
	variants: {
		size: {
			icon: "h-[24px]",
			sm: "h-[56px]",
			md: "h-[112px]",
			lg: "h-[224px]",
			xl: "h-[448px]",
		},
	},
	defaultVariants: { size: "lg" },
});

export interface AudioVisualizerWaveProps {
	blur?: number;
	className?: string;
	color?: `#${string}`;
	colorShift?: number;
	lineWidth?: number;
	size?: VisualizerSize;
}

export function AudioVisualizerWave({
	size = "lg",
	color,
	colorShift = 0.05,
	lineWidth,
	blur,
	className,
	...props
}: AudioVisualizerWaveProps & ComponentProps<"div">) {
	const state = useAgentState();

	let _lineWidth: number;
	if (lineWidth === undefined) {
		_lineWidth = size === "icon" || size === "sm" ? 2 : 1;
	} else {
		_lineWidth = lineWidth;
	}

	const rgbColor = hexToRgb(color ?? DEFAULT_COLOR);
	const smoothing = blur ?? 0.5;

	// Mutable uniforms ref — animators write here directly, ReactShaderToy reads on each frame
	const uniformsRef = useRef<Uniforms>({
		uSpeed: { type: "1f", value: 5 },
		uAmplitude: { type: "1f", value: 0.08 },
		uFrequency: { type: "1f", value: 10 },
		uMix: { type: "1f", value: 1.0 },
		uLineWidth: { type: "1f", value: _lineWidth },
		uSmoothing: { type: "1f", value: smoothing },
		uColor: { type: "3fv", value: rgbColor },
		uColorShift: { type: "1f", value: colorShift },
	});

	// Keep non-animated uniforms in sync with props (post-render mutation; ReactShaderToy
	// reads uniformsRef on each rAF tick, so the next frame picks up the new values).
	useEffect(() => {
		uniformsRef.current.uLineWidth = { type: "1f", value: _lineWidth };
		uniformsRef.current.uSmoothing = { type: "1f", value: smoothing };
		uniformsRef.current.uColor = { type: "3fv", value: rgbColor };
		uniformsRef.current.uColorShift = { type: "1f", value: colorShift };
	}, [_lineWidth, smoothing, rgbColor, colorShift]);

	// Hook up motion-value-driven animations that write to uniformsRef (zero re-renders)
	useWaveAnimator(state, uniformsRef);

	return (
		<div
			className={cn(
				waveVariants({ size }),
				"mask-[linear-gradient(90deg,transparent_0%,black_20%,black_80%,transparent_100%)]",
				className
			)}
			data-lk-state={state}
			{...props}
		>
			<ReactShaderToy
				devicePixelRatio={globalThis.devicePixelRatio ?? 1}
				fs={waveShaderSource}
				onError={(error) => console.error("Shader error:", error)}
				onWarning={(warning) => console.warn("Shader warning:", warning)}
				style={{ width: "100%", height: "100%" }}
				// react-doctor-disable-next-line react-hooks-js/refs -- intentional: ReactShaderToy reads this mutable container on each frame
				uniforms={uniformsRef.current}
			/>
		</div>
	);
}

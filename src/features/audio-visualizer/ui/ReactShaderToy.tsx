/**
 * @license MIT
 * Copyright (c) 2018 Morgan Villedieu
 * Copyright (c) 2023 Rysana, Inc.
 * Copyright (c) 2026 LiveKit, Inc.
 *
 * Adapted for WinSTT — no LiveKit SDK dependencies.
 */

import {
	type ComponentPropsWithoutRef,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	BASIC_FS,
	BASIC_VS,
	FS_MAIN_SHADER,
	GLSL_IDENT_RE,
	insertStringAtIndex,
	log,
	PRECISIONS,
	processUniform,
	UNIFORM_DATE,
	UNIFORM_DEVICEORIENTATION,
	UNIFORM_FRAME,
	UNIFORM_MOUSE,
	UNIFORM_RESOLUTION,
	UNIFORM_TIME,
	UNIFORM_TIMEDELTA,
	uniformTypeToGLSLType,
} from "../lib/glsl-uniforms";
import type { ReactShaderToyProps, Uniforms, UniformsProp } from "../lib/shader-toy-types";

export type { ReactShaderToyProps, Uniforms, UniformsProp } from "../lib/shader-toy-types";

const EMPTY_CONTEXT_ATTRIBUTES: Record<string, unknown> = {};

function useShaderToyEngine(
	canvasRef: RefObject<HTMLCanvasElement | null>,
	{
		fs,
		vs,
		uniforms: propUniforms,
		clearColor,
		precision,
		contextAttributes,
		devicePixelRatio,
		onError,
		onWarning,
		animateWhenNotVisible,
	}: Required<
		Pick<
			ReactShaderToyProps,
			| "fs"
			| "vs"
			| "clearColor"
			| "precision"
			| "contextAttributes"
			| "devicePixelRatio"
			| "onError"
			| "onWarning"
			| "animateWhenNotVisible"
		>
	> & {
		uniforms: UniformsProp | undefined;
	}
): void {
	const glRef = useRef<WebGLRenderingContext | null>(null);
	const squareVerticesBufferRef = useRef<WebGLBuffer | null>(null);
	const shaderProgramRef = useRef<WebGLProgram | null>(null);
	const vertexPositionAttributeRef = useRef<number | undefined>(undefined);
	const animFrameIdRef = useRef<number | undefined>(undefined);
	const initFrameIdRef = useRef<number | undefined>(undefined);
	const isVisibleRef = useRef(true);
	const animateWhenNotVisibleRef = useRef(animateWhenNotVisible);
	const timerRef = useRef(0);
	const lastTimeRef = useRef(0);
	const resizeObserverRef = useRef<ResizeObserver | undefined>(undefined);
	const uniformsRef = useRef<
		Record<string, { type: string; isNeeded: boolean; value?: number[] | number }>
	>({
		[UNIFORM_TIME]: { type: "float", isNeeded: false, value: 0 },
		[UNIFORM_TIMEDELTA]: { type: "float", isNeeded: false, value: 0 },
		[UNIFORM_DATE]: { type: "vec4", isNeeded: false, value: [0, 0, 0, 0] },
		[UNIFORM_MOUSE]: { type: "vec4", isNeeded: false, value: [0, 0, 0, 0] },
		[UNIFORM_RESOLUTION]: { type: "vec2", isNeeded: false, value: [0, 0] },
		[UNIFORM_FRAME]: { type: "int", isNeeded: false, value: 0 },
		[UNIFORM_DEVICEORIENTATION]: { type: "vec4", isNeeded: false, value: [0, 0, 0, 0] },
	});
	// Normalize the union prop: keep a snapshot OR a thunk. Either way, the
	// engine reads through `readPropUniforms()` which never reads `.current`
	// during render.
	const propsUniformsRef = useRef<Uniforms | undefined>(
		typeof propUniforms === "function" ? undefined : propUniforms
	);
	const getUniformsFnRef = useRef<(() => Uniforms | undefined) | null>(
		typeof propUniforms === "function" ? propUniforms : null
	);
	function readPropUniforms(): Uniforms | undefined {
		return getUniformsFnRef.current ? getUniformsFnRef.current() : propsUniformsRef.current;
	}

	const initWebGL = () => {
		if (!canvasRef.current) {
			return;
		}
		glRef.current = (canvasRef.current.getContext("webgl", contextAttributes) ||
			canvasRef.current.getContext(
				"experimental-webgl",
				contextAttributes
			)) as WebGLRenderingContext | null;
		glRef.current?.getExtension("OES_standard_derivatives");
		glRef.current?.getExtension("EXT_shader_texture_lod");
	};

	const initBuffers = () => {
		const gl = glRef.current;
		squareVerticesBufferRef.current = gl?.createBuffer() ?? null;
		gl?.bindBuffer(gl.ARRAY_BUFFER, squareVerticesBufferRef.current);
		const vertices = [1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, -1.0, -1.0, 0.0];
		gl?.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
	};

	const onResize = () => {
		const gl = glRef.current;
		if (!gl) {
			return;
		}
		const rect = canvasRef.current?.getBoundingClientRect();
		const realToCSSPixels = devicePixelRatio;
		const displayWidth = Math.floor((rect?.width ?? 1) * realToCSSPixels);
		const displayHeight = Math.floor((rect?.height ?? 1) * realToCSSPixels);
		gl.canvas.width = displayWidth;
		gl.canvas.height = displayHeight;
		if (uniformsRef.current.iResolution?.isNeeded && shaderProgramRef.current) {
			const rUniform = gl.getUniformLocation(shaderProgramRef.current, UNIFORM_RESOLUTION);
			gl.uniform2fv(rUniform, [gl.canvas.width, gl.canvas.height]);
		}
	};

	const createShader = (type: number, shaderCodeAsText: string) => {
		const gl = glRef.current;
		if (!gl) {
			return null;
		}
		const shader = gl.createShader(type);
		if (!shader) {
			return null;
		}
		gl.shaderSource(shader, shaderCodeAsText);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			onWarning?.(log(`Error compiling the shader:\n${shaderCodeAsText}`));
			const compilationLog = gl.getShaderInfoLog(shader);
			gl.deleteShader(shader);
			onError?.(log(`Shader compiler log: ${compilationLog}`));
		}
		return shader;
	};

	const initShaders = (fragmentShader: string, vertexShader: string) => {
		const gl = glRef.current;
		if (!gl) {
			return;
		}
		const fragmentShaderObj = createShader(gl.FRAGMENT_SHADER, fragmentShader);
		const vertexShaderObj = createShader(gl.VERTEX_SHADER, vertexShader);
		shaderProgramRef.current = gl.createProgram();
		if (!(shaderProgramRef.current && vertexShaderObj && fragmentShaderObj)) {
			return;
		}
		gl.attachShader(shaderProgramRef.current, vertexShaderObj);
		gl.attachShader(shaderProgramRef.current, fragmentShaderObj);
		gl.linkProgram(shaderProgramRef.current);
		if (!gl.getProgramParameter(shaderProgramRef.current, gl.LINK_STATUS)) {
			onError?.(
				log(
					`Unable to initialize the shader program: ${gl.getProgramInfoLog(shaderProgramRef.current)}`
				)
			);
			return;
		}
		gl.useProgram(shaderProgramRef.current);
		vertexPositionAttributeRef.current = gl.getAttribLocation(
			shaderProgramRef.current,
			"aVertexPosition"
		);
		gl.enableVertexAttribArray(vertexPositionAttributeRef.current);
	};

	const processCustomUniforms = () => {
		const current = readPropUniforms();
		if (!current) {
			return;
		}
		for (const name of Object.keys(current)) {
			const uniform = current[name];
			if (!uniform) {
				continue;
			}
			const { value, type } = uniform;
			const glslType = uniformTypeToGLSLType(type);
			if (!glslType) {
				continue;
			}
			uniformsRef.current[name] = { type: glslType, isNeeded: false, value };
		}
	};

	const preProcessFragment = (fragment: string) => {
		const isValidPrecision = PRECISIONS.includes(precision ?? "highp");
		const precisionString = `precision ${isValidPrecision ? precision : PRECISIONS[1]} float;\n`;
		let fragmentShader = precisionString
			.concat(`#define DPR ${devicePixelRatio.toFixed(1)}\n`)
			.concat(fragment.replace(/texture\(/g, "texture2D("));
		// Tokenize the source once into a Set so each membership check below
		// is O(1) instead of O(n) per uniform. Identifier-boundary matching
		// also fixes a latent bug where `iTime` matched `iTimeDelta`.
		const referencedNames = new Set(fragment.match(GLSL_IDENT_RE) ?? []);
		for (const uniform of Object.keys(uniformsRef.current)) {
			if (referencedNames.has(uniform)) {
				const u = uniformsRef.current[uniform];
				if (!u) {
					continue;
				}
				fragmentShader = insertStringAtIndex(
					fragmentShader,
					`uniform ${u.type} ${uniform}; \n`,
					fragmentShader.lastIndexOf(precisionString) + precisionString.length
				);
				u.isNeeded = true;
			}
		}
		if (fragment.includes("mainImage")) {
			fragmentShader = fragmentShader.concat(FS_MAIN_SHADER);
		}
		return fragmentShader;
	};

	const setUniforms = (timestamp: number) => {
		const gl = glRef.current;
		if (!(gl && shaderProgramRef.current)) {
			return;
		}
		const delta = lastTimeRef.current ? (timestamp - lastTimeRef.current) / 1000 : 0;
		lastTimeRef.current = timestamp;
		const pu = readPropUniforms();
		if (pu) {
			for (const name of Object.keys(pu)) {
				const currentUniform = pu[name];
				if (!currentUniform) {
					continue;
				}
				if (uniformsRef.current[name]?.isNeeded) {
					const loc = gl.getUniformLocation(shaderProgramRef.current, name);
					if (!loc) {
						continue;
					}
					processUniform(gl, loc, currentUniform.type, currentUniform.value);
				}
			}
		}
		if (uniformsRef.current.iTime?.isNeeded) {
			const timeUniform = gl.getUniformLocation(shaderProgramRef.current, UNIFORM_TIME);
			gl.uniform1f(timeUniform, (timerRef.current += delta));
		}
		if (uniformsRef.current.iTimeDelta?.isNeeded) {
			const loc = gl.getUniformLocation(shaderProgramRef.current, UNIFORM_TIMEDELTA);
			gl.uniform1f(loc, delta);
		}
		if (uniformsRef.current.iDate?.isNeeded) {
			const d = new Date();
			const time =
				d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() * 0.001;
			const loc = gl.getUniformLocation(shaderProgramRef.current, UNIFORM_DATE);
			gl.uniform4fv(loc, [d.getFullYear(), d.getMonth() + 1, d.getDate(), time]);
		}
		if (uniformsRef.current.iFrame?.isNeeded) {
			const loc = gl.getUniformLocation(shaderProgramRef.current, UNIFORM_FRAME);
			const frameVal = uniformsRef.current.iFrame.value;
			const frame = typeof frameVal === "number" ? frameVal : 0;
			uniformsRef.current.iFrame.value = frame + 1;
			gl.uniform1i(loc, frame);
		}
	};

	const drawScene = (timestamp: number) => {
		const gl = glRef.current;
		if (!gl) {
			return;
		}
		gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.bindBuffer(gl.ARRAY_BUFFER, squareVerticesBufferRef.current);
		gl.vertexAttribPointer(vertexPositionAttributeRef.current ?? 0, 3, gl.FLOAT, false, 0, 0);
		setUniforms(timestamp);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		if (animateWhenNotVisibleRef.current || isVisibleRef.current) {
			animFrameIdRef.current = requestAnimationFrame(drawScene);
		}
	};

	useEffect(() => {
		if (typeof propUniforms === "function") {
			getUniformsFnRef.current = propUniforms;
			propsUniformsRef.current = undefined;
		} else {
			getUniformsFnRef.current = null;
			propsUniformsRef.current = propUniforms;
		}
	}, [propUniforms]);

	// Mirror animateWhenNotVisible prop into a latest-ref consumed by the
	// long-running rAF loop (drawScene). Pure prop→ref sync — no side effects
	// inside the effect body.
	useEffect(() => {
		animateWhenNotVisibleRef.current = animateWhenNotVisible;
	}, [animateWhenNotVisible]);

	// Seed isVisibleRef on every toggle: when the prop is true the IO observer
	// effect short-circuits, so the rAF loop needs an explicit "visible" hint.
	// Doing the seed here (its own narrow effect) keeps both the prop-sync and
	// the IO setup effects free of conditional side-effects.
	useEffect(() => {
		isVisibleRef.current = animateWhenNotVisible;
	}, [animateWhenNotVisible]);

	// Pin handlers/setup to stable per-mount references so the deps array can
	// honestly list everything the effects close over, without re-triggering
	// the mount-only WebGL bringup on each render.
	const [pinnedHandlers] = useState(() => ({
		initWebGL,
		initBuffers,
		initShaders,
		processCustomUniforms,
		preProcessFragment,
		drawScene,
		onResize,
	}));
	const [pinnedInitOpts] = useState(() => ({ fs, vs, clearColor }));

	useEffect(() => {
		if (animateWhenNotVisible || !canvasRef.current) {
			return;
		}
		const canvas = canvasRef.current;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					isVisibleRef.current = entry.isIntersecting;
					if (entry.isIntersecting) {
						requestAnimationFrame(pinnedHandlers.drawScene);
					}
				}
			},
			{ threshold: 0 }
		);
		observer.observe(canvas);
		return () => observer.disconnect();
	}, [animateWhenNotVisible, pinnedHandlers, canvasRef]);

	useEffect(() => {
		const canvasNode = canvasRef.current;
		if (!canvasNode) {
			return;
		}
		const resizeHandler = pinnedHandlers.onResize;

		// (Re)build the whole GL scene on whatever context is currently live.
		// Idempotent so it can run both on the initial mount AND after a
		// `webglcontextrestored` event — it recompiles shaders, recreates the
		// vertex buffer, and restarts the draw loop on the fresh context.
		// Cancels any in-flight rAF first so a restore never stacks two loops.
		const bootstrapScene = () => {
			const gl = glRef.current;
			if (!gl) {
				return;
			}
			const [r, g, b, a] = pinnedInitOpts.clearColor;
			gl.clearColor(r, g, b, a);
			gl.clearDepth(1.0);
			gl.enable(gl.DEPTH_TEST);
			gl.depthFunc(gl.LEQUAL);
			gl.viewport(0, 0, canvasNode.width, canvasNode.height);
			canvasNode.height = canvasNode.clientHeight;
			canvasNode.width = canvasNode.clientWidth;
			pinnedHandlers.processCustomUniforms();
			pinnedHandlers.initShaders(
				pinnedHandlers.preProcessFragment(pinnedInitOpts.fs || BASIC_FS),
				pinnedInitOpts.vs || BASIC_VS
			);
			pinnedHandlers.initBuffers();
			cancelAnimationFrame(initFrameIdRef.current ?? 0);
			cancelAnimationFrame(animFrameIdRef.current ?? 0);
			initFrameIdRef.current = requestAnimationFrame(pinnedHandlers.drawScene);
			resizeHandler();
		};

		// A WebGL context can be lost at any time — a GPU TDR/driver reset, a
		// sleep/wake, or Chromium evicting the least-recently-used context once
		// too many are live across the app's windows. Without `preventDefault`
		// on `webglcontextlost` the browser marks the context UNrestorable and
		// paints its grey sad-face placeholder forever; calling it opts into the
		// paired `webglcontextrestored` event, where we rebuild the scene.
		//
		// This is also why cleanup below no longer eagerly calls
		// `WEBGL_lose_context.loseContext()`: React StrictMode (dev) runs every
		// effect mount→cleanup→mount on the SAME <canvas>, and a canvas only ever
		// hands out one WebGL context — losing it on the first cleanup left the
		// remount holding a dead context, which is exactly the sad-face the
		// wave/aura presets showed in the main window. Not losing it lets the
		// remount rebuild on the still-live context.
		const handleContextLost = (event: Event) => {
			event.preventDefault();
			cancelAnimationFrame(initFrameIdRef.current ?? 0);
			cancelAnimationFrame(animFrameIdRef.current ?? 0);
		};
		const handleContextRestored = () => {
			pinnedHandlers.initWebGL();
			bootstrapScene();
		};
		canvasNode.addEventListener("webglcontextlost", handleContextLost);
		canvasNode.addEventListener("webglcontextrestored", handleContextRestored);

		pinnedHandlers.initWebGL();
		const gl = glRef.current;
		let observer: ResizeObserver | null = null;
		if (gl) {
			bootstrapScene();
			observer = new ResizeObserver(resizeHandler);
			observer.observe(canvasNode);
			resizeObserverRef.current = observer;
			window.addEventListener("resize", resizeHandler, { passive: true });
		}

		return () => {
			canvasNode.removeEventListener("webglcontextlost", handleContextLost);
			canvasNode.removeEventListener("webglcontextrestored", handleContextRestored);
			cancelAnimationFrame(initFrameIdRef.current ?? 0);
			cancelAnimationFrame(animFrameIdRef.current ?? 0);
			if (observer) {
				observer.disconnect();
				window.removeEventListener("resize", resizeHandler);
			}
			// Free the GPU-side program + buffer (the bulk of this context's
			// memory) but leave the context itself alive — the canvas reclaims
			// it on GC at real unmount, and keeping it live is what lets a
			// StrictMode remount rebuild instead of inheriting a dead context.
			const liveGl = glRef.current;
			if (liveGl && !liveGl.isContextLost()) {
				liveGl.useProgram(null);
				liveGl.deleteProgram(shaderProgramRef.current ?? null);
				liveGl.deleteBuffer(squareVerticesBufferRef.current ?? null);
			}
		};
	}, [pinnedHandlers, pinnedInitOpts, canvasRef]);
}

export function ReactShaderToy({
	fs,
	vs = BASIC_VS,
	uniforms: propUniforms,
	clearColor = [0, 0, 0, 1],
	precision = "highp",
	style,
	contextAttributes = EMPTY_CONTEXT_ATTRIBUTES,
	devicePixelRatio = 1,
	onError = console.error,
	onWarning = console.warn,
	animateWhenNotVisible = false,
	...canvasProps
}: ReactShaderToyProps & ComponentPropsWithoutRef<"canvas">) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	useShaderToyEngine(canvasRef, {
		fs,
		vs,
		uniforms: propUniforms,
		clearColor,
		precision,
		contextAttributes,
		devicePixelRatio,
		onError,
		onWarning,
		animateWhenNotVisible,
	});

	return (
		<canvas ref={canvasRef} style={{ height: "100%", width: "100%", ...style }} {...canvasProps} />
	);
}

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { ReactShaderToy } from "./ReactShaderToy";

function Probe() {
	return <ReactShaderToy fs="" uniforms={{}} vs="" />;
}

describe("ReactShaderToy", () => {
	test("renders a canvas element (WebGL is unavailable in happy-dom; we just verify mount)", () => {
		const { container } = render(<Probe />);
		// Component renders a canvas regardless of WebGL availability
		expect(container.querySelector("canvas")).not.toBeNull();
	});
});

// A minimal WebGL stub. happy-dom returns `null` for getContext("webgl"), so
// without this the engine's whole init/teardown path is dead code in tests.
// The stub returns sane values for the handful of calls whose RESULT matters
// (shaders compile/link OK, context not lost) and a no-op for everything else,
// so we can assert the lifecycle invariants the fix depends on.
function installFakeWebGl() {
	const loseContext = mock(() => undefined);
	const restoreContext = mock(() => undefined);
	const ext = { loseContext, restoreContext };

	const buildContext = (canvas: HTMLCanvasElement) => {
		const overrides: Record<string, unknown> = {
			canvas,
			getExtension: () => ext,
			getShaderParameter: () => true,
			getProgramParameter: () => true,
			isContextLost: () => false,
			getAttribLocation: () => 0,
			getUniformLocation: () => ({}),
			createShader: () => ({}),
			createProgram: () => ({}),
			createBuffer: () => ({}),
			getShaderInfoLog: () => "",
			getProgramInfoLog: () => "",
		};
		return new Proxy(overrides, {
			get(target, prop) {
				if (typeof prop === "string" && prop in target) {
					return target[prop];
				}
				// GL numeric constants are SCREAMING_CASE; everything else is a
				// no-op method.
				if (typeof prop === "string" && /^[A-Z0-9_]+$/.test(prop)) {
					return 1;
				}
				return () => undefined;
			},
		}) as unknown as WebGLRenderingContext;
	};

	const realGetContext = HTMLCanvasElement.prototype.getContext;
	const getContextSpy = mock(function (this: HTMLCanvasElement, type: string) {
		if (type === "webgl" || type === "experimental-webgl") {
			return buildContext(this);
		}
		return null;
	});
	HTMLCanvasElement.prototype.getContext =
		getContextSpy as unknown as typeof HTMLCanvasElement.prototype.getContext;

	const realRaf = globalThis.requestAnimationFrame;
	const realCancel = globalThis.cancelAnimationFrame;
	// Hand out ids but never invoke the callback — keeps the draw loop from
	// recursing during the synchronous test while still exercising the
	// schedule/cancel bookkeeping.
	let rafId = 0;
	globalThis.requestAnimationFrame = mock(() => ++rafId) as typeof requestAnimationFrame;
	globalThis.cancelAnimationFrame = mock(() => undefined) as typeof cancelAnimationFrame;

	return {
		loseContext,
		restoreContext,
		getContextSpy,
		restore() {
			HTMLCanvasElement.prototype.getContext = realGetContext;
			globalThis.requestAnimationFrame = realRaf;
			globalThis.cancelAnimationFrame = realCancel;
		},
	};
}

describe("ReactShaderToy WebGL lifecycle", () => {
	let gl: ReturnType<typeof installFakeWebGl>;

	beforeEach(() => {
		gl = installFakeWebGl();
	});
	afterEach(() => {
		gl.restore();
	});

	test("never eagerly loses the context — a StrictMode mount→unmount→mount keeps a live context (regression: wave/aura sad-face)", () => {
		// StrictMode double-invokes effects on the SAME <canvas>. The old code
		// called WEBGL_lose_context.loseContext() on the intermediate cleanup,
		// permanently killing the canvas's only context so the remount inherited
		// a dead one (Chromium's grey sad-face placeholder).
		const { unmount } = render(
			<StrictMode>
				<Probe />
			</StrictMode>
		);
		expect(gl.loseContext).not.toHaveBeenCalled();
		unmount();
		expect(gl.loseContext).not.toHaveBeenCalled();
	});

	test("registers context-loss/restore handlers and preventDefaults a loss so it stays restorable", () => {
		const { container } = render(<Probe />);
		const canvas = container.querySelector("canvas");
		expect(canvas).not.toBeNull();
		const node = canvas as HTMLCanvasElement;

		// getContext was queried for the initial bringup.
		const callsAfterMount = gl.getContextSpy.mock.calls.length;
		expect(callsAfterMount).toBeGreaterThan(0);

		// A lost-context event must be cancelled (preventDefault) — otherwise the
		// browser marks the context unrestorable and shows the placeholder.
		const lost = new Event("webglcontextlost", { cancelable: true });
		node.dispatchEvent(lost);
		expect(lost.defaultPrevented).toBe(true);

		// Restoring rebuilds the scene, which re-queries the context.
		node.dispatchEvent(new Event("webglcontextrestored"));
		expect(gl.getContextSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);
	});
});

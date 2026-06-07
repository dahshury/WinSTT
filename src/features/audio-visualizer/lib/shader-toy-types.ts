/**
 * @license MIT
 * Copyright (c) 2018 Morgan Villedieu
 * Copyright (c) 2023 Rysana, Inc.
 * Copyright (c) 2026 LiveKit, Inc.
 *
 * Adapted for WinSTT — no LiveKit SDK dependencies.
 */

import type { CSSProperties } from "react";

type Uniform = { type: string; value: number[] | number };
export type Uniforms = Record<string, Uniform>;

/**
 * `uniforms` accepts either a plain object (snapshot semantics — read each
 * frame) or a thunk `() => Uniforms | undefined` (live-mutation channel — the
 * engine calls the thunk each frame, so callers can return a stable ref's
 * current value without ever reading the ref during render).
 */
export type UniformsProp = Uniforms | (() => Uniforms | undefined);

export interface ReactShaderToyProps {
	animateWhenNotVisible?: boolean;
	clearColor?: [number, number, number, number];
	contextAttributes?: Record<string, unknown>;
	devicePixelRatio?: number;
	fs: string;
	onError?: (error: string) => void;
	onWarning?: (warning: string) => void;
	precision?: "highp" | "lowp" | "mediump";
	style?: CSSProperties;
	uniforms?: UniformsProp;
	vs?: string;
}

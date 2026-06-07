/**
 * @license MIT
 * Copyright (c) 2018 Morgan Villedieu
 * Copyright (c) 2023 Rysana, Inc.
 * Copyright (c) 2026 LiveKit, Inc.
 *
 * Adapted for WinSTT — no LiveKit SDK dependencies.
 */

/** GLSL identifier tokenizer — used to collect every name referenced in a shader source. */
export const GLSL_IDENT_RE = /\b[A-Za-z_]\w*\b/g;

export const PRECISIONS = ["lowp", "mediump", "highp"];
export const FS_MAIN_SHADER = `\nvoid main(void){
    vec4 color = vec4(0.0,0.0,0.0,1.0);
    mainImage( color, gl_FragCoord.xy );
    gl_FragColor = color;
}`;
export const BASIC_FS = `void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
    vec2 uv = fragCoord/iResolution.xy;
    vec3 col = 0.5 + 0.5*cos(iTime+uv.xyx+vec3(0,2,4));
    fragColor = vec4(col,1.0);
}`;
export const BASIC_VS = `attribute vec3 aVertexPosition;
void main(void) {
    gl_Position = vec4(aVertexPosition, 1.0);
}`;
export const UNIFORM_TIME = "iTime";
export const UNIFORM_TIMEDELTA = "iTimeDelta";
export const UNIFORM_DATE = "iDate";
export const UNIFORM_FRAME = "iFrame";
export const UNIFORM_MOUSE = "iMouse";
export const UNIFORM_RESOLUTION = "iResolution";
export const UNIFORM_DEVICEORIENTATION = "iDeviceOrientation";

function isVectorType(
	t: string,
	v: number[] | number,
): v is [number, number, number, number] {
	return (
		!t.includes("v") &&
		Array.isArray(v) &&
		v.length > Number.parseInt(t.charAt(0))
	);
}

export const processUniform = (
	gl: WebGLRenderingContext,
	location: WebGLUniformLocation,
	t: string,
	value: number | number[],
) => {
	if (isVectorType(t, value)) {
		switch (t) {
			case "2f":
				return gl.uniform2f(location, value[0], value[1]);
			case "3f":
				return gl.uniform3f(location, value[0], value[1], value[2]);
			case "4f":
				return gl.uniform4f(location, value[0], value[1], value[2], value[3]);
			case "2i":
				return gl.uniform2i(location, value[0], value[1]);
			case "3i":
				return gl.uniform3i(location, value[0], value[1], value[2]);
			case "4i":
				return gl.uniform4i(location, value[0], value[1], value[2], value[3]);
		}
	}
	if (typeof value === "number") {
		switch (t) {
			case "1i":
				return gl.uniform1i(location, value);
			default:
				return gl.uniform1f(location, value);
		}
	}
	switch (t) {
		case "1iv":
			return gl.uniform1iv(location, value);
		case "2iv":
			return gl.uniform2iv(location, value);
		case "3iv":
			return gl.uniform3iv(location, value);
		case "4iv":
			return gl.uniform4iv(location, value);
		case "1fv":
			return gl.uniform1fv(location, value);
		case "2fv":
			return gl.uniform2fv(location, value);
		case "3fv":
			return gl.uniform3fv(location, value);
		case "4fv":
			return gl.uniform4fv(location, value);
		case "Matrix2fv":
			return gl.uniformMatrix2fv(location, false, value);
		case "Matrix3fv":
			return gl.uniformMatrix3fv(location, false, value);
		case "Matrix4fv":
			return gl.uniformMatrix4fv(location, false, value);
	}
};

export const uniformTypeToGLSLType = (t: string) => {
	const map: Record<string, string> = {
		"1f": "float",
		"2f": "vec2",
		"3f": "vec3",
		"4f": "vec4",
		"1i": "int",
		"2i": "ivec2",
		"3i": "ivec3",
		"4i": "ivec4",
		"1iv": "int",
		"2iv": "ivec2",
		"3iv": "ivec3",
		"4iv": "ivec4",
		"1fv": "float",
		"2fv": "vec2",
		"3fv": "vec3",
		"4fv": "vec4",
		Matrix2fv: "mat2",
		Matrix3fv: "mat3",
		Matrix4fv: "mat4",
	};
	return map[t];
};

export const log = (text: string) => `react-shaders: ${text}`;
export const insertStringAtIndex = (
	currentString: string,
	string: string,
	index: number,
) =>
	index > 0
		? currentString.substring(0, index) +
			string +
			currentString.substring(index)
		: string + currentString;

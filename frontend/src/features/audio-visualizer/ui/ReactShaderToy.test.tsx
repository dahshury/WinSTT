import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
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

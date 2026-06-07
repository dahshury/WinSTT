import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { SurfaceProvider } from "@/shared/lib/surface";
import { MicrophoneLevelMeter } from "./MicrophoneLevelMeter";

describe("MicrophoneLevelMeter", () => {
	test("keeps idle meter segments visible on the current surface", () => {
		const { container } = render(
			<SurfaceProvider value={5}>
				<MicrophoneLevelMeter active={true} level={0} />
			</SurfaceProvider>,
		);

		const segments = container.querySelectorAll(
			'[data-slot="microphone-level-meter-segment"]',
		);
		expect(segments).toHaveLength(6);
		for (const segment of segments) {
			expect(segment.className).toContain("bg-surface-7");
			expect(segment.className).toContain("ring-divider-strong");
		}
	});
});

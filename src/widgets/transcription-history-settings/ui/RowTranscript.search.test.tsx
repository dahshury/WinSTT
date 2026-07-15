import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { RowTranscript } from "./RowTranscript";

describe("RowTranscript search highlights", () => {
	test("marks the supplied ranges in the displayed text", () => {
		const { container } = render(
			<IntlProvider>
				<RowTranscript
					activeIndex={-1}
					diff={null}
					displayText="find this phrase"
					highlights={[{ end: 9, start: 5 }]}
					playbackActive={false}
					viewFullLabel="Full transcript"
					words={null}
				/>
			</IntlProvider>,
		);

		expect(container.querySelector("mark")?.textContent).toBe("this");
	});

	test("does not render search marks in the word-timing playback view", () => {
		const { container } = render(
			<IntlProvider>
				<RowTranscript
					activeIndex={0}
					diff={null}
					displayText="find this"
					highlights={[{ end: 4, start: 0 }]}
					playbackActive
					viewFullLabel="Full transcript"
					words={[{ end: 0.5, start: 0, text: "find" }]}
				/>
			</IntlProvider>,
		);

		expect(container.querySelector("mark")).toBeNull();
	});
});

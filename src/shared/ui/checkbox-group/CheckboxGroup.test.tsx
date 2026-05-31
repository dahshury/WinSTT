import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { CheckboxGroup, CheckboxItem } from "./CheckboxGroup";

describe("CheckboxItem trailing-control propagation", () => {
	// Regression: the trailing wrapper used to attach a *native*
	// addEventListener("click", stopPropagation). React 19 delegates synthetic
	// events to the root container, so a native stopPropagation on the wrapper
	// fired before the root and swallowed the inner control's own React
	// onClick entirely — e.g. the Concise/Summarize level switcher never
	// changed because its Toggle's click never reached React. The wrapper must
	// use React's synthetic handlers so the inner control fires first and only
	// then is propagation to the row stopped.
	test("inner trailing control receives its click; row onToggle does not", () => {
		const onToggle = mock(() => undefined);
		const onInner = mock(() => undefined);

		const { getByText } = render(
			<CheckboxGroup checkedIndices={new Set()}>
				<CheckboxItem
					checked={false}
					index={0}
					label="Concise"
					onToggle={onToggle}
					trailing={
						<button onClick={onInner} type="button">
							high
						</button>
					}
				/>
			</CheckboxGroup>
		);

		fireEvent.click(getByText("high"));

		expect(onInner).toHaveBeenCalledTimes(1);
		expect(onToggle).not.toHaveBeenCalled();
	});

	test("clicking the row itself still toggles", () => {
		const onToggle = mock(() => undefined);

		const { getByRole } = render(
			<CheckboxGroup checkedIndices={new Set()}>
				<CheckboxItem checked={false} index={0} label="Concise" onToggle={onToggle} />
			</CheckboxGroup>
		);

		fireEvent.click(getByRole("checkbox", { name: "Concise" }));

		expect(onToggle).toHaveBeenCalledTimes(1);
	});
});

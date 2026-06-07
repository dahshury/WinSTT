import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { DownloadActions, type DownloadPhase } from "./DownloadActions";

const LABELS = {
	download: "Pull",
	stop: "Stop",
	resume: "Resume",
	discard: "Discard",
};

function renderInClickableCard(phase: DownloadPhase) {
	const onCardClick = mock(() => undefined);
	const onCardPointerDown = mock(() => undefined);
	const onDownload = mock(() => undefined);
	const onStop = mock(() => undefined);
	const onResume = mock(() => undefined);
	const onDiscard = mock(() => undefined);

	render(
		<div onClick={onCardClick} onPointerDown={onCardPointerDown}>
			<DownloadActions
				labels={LABELS}
				onDiscard={onDiscard}
				onDownload={onDownload}
				onResume={onResume}
				onStop={onStop}
				phase={phase}
				size="sm"
			/>
		</div>,
	);

	return {
		onCardClick,
		onCardPointerDown,
		onDiscard,
		onDownload,
		onResume,
		onStop,
	};
}

describe("DownloadActions events", () => {
	test("active stop click does not activate the parent card", () => {
		const { onCardClick, onCardPointerDown, onStop } =
			renderInClickableCard("active");

		const stop = screen.getByRole("button", { name: "Stop" });
		fireEvent.pointerDown(stop);
		fireEvent.click(stop);

		expect(onCardPointerDown).not.toHaveBeenCalled();
		expect(onCardClick).not.toHaveBeenCalled();
		expect(onStop).toHaveBeenCalledTimes(1);
	});

	test("paused discard click does not activate the parent card", () => {
		const { onCardClick, onCardPointerDown, onDiscard } =
			renderInClickableCard("paused");

		const discard = screen.getByRole("button", { name: "Discard" });
		fireEvent.pointerDown(discard);
		fireEvent.click(discard);

		expect(onCardPointerDown).not.toHaveBeenCalled();
		expect(onCardClick).not.toHaveBeenCalled();
		expect(onDiscard).toHaveBeenCalledTimes(1);
	});
});

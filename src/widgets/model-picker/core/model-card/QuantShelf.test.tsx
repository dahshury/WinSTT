import { describe, expect, mock, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import {
	buildQuantTooltipContent,
	QuantShelf,
	type QuantShelfEntry,
} from "./QuantShelf";

function entry(overrides: Partial<QuantShelfEntry> = {}): QuantShelfEntry {
	return {
		actionQuant: "gemma3:4b-q4_K_M",
		cacheProgress: null,
		cacheState: "not_cached",
		cacheStatusLabel: "Not downloaded",
		canDelete: false,
		canStartDownload: true,
		download: undefined,
		isActive: false,
		isRecommended: false,
		label: "q4_K_M",
		mono: true,
		tooltip: "Small and fast.",
		value: "gemma3:4b-q4_K_M",
		...overrides,
	};
}

function renderInClickableCard(quantEntry: QuantShelfEntry) {
	const onCardClick = mock(() => undefined);
	const onCardPointerDown = mock(() => undefined);
	const onDownloadAction = mock(() => undefined);
	const onSelect = mock(() => undefined);

	render(
		<TooltipProvider.Provider>
			<div onClick={onCardClick} onPointerDown={onCardPointerDown}>
				<QuantShelf
					entries={[quantEntry]}
					modelDisplayName="Gemma 3"
					modelId="gemma3"
					onDownloadAction={onDownloadAction}
					onSelect={onSelect}
					showIcon={false}
				/>
			</div>
		</TooltipProvider.Provider>,
	);

	return { onCardClick, onCardPointerDown, onDownloadAction, onSelect };
}

describe("QuantShelf badge events", () => {
	test("tooltip content separates status, download size, and precision detail", () => {
		expect(
			buildQuantTooltipContent(
				entry({
					downloadSizeBytes: 512,
					isRecommended: true,
					label: "fp16",
					tooltip: "16-bit float.",
				}),
				"Click to download.",
			),
		).toBe(
			"fp16 (recommended)\nStatus: Not downloaded. Click to download.\nDownload size: 512 B\nPrecision: 16-bit float.",
		);
	});

	test("tooltip content prefers scraped size labels when present", () => {
		expect(
			buildQuantTooltipContent(
				entry({
					downloadSizeBytes: null,
					downloadSizeLabel: "4.1 GB",
					tooltip: "",
				}),
				null,
			),
		).toBe("q4_K_M\nStatus: Not downloaded\nDownload size: 4.1 GB");
	});

	test("tooltip content prefers live aggregate totals over stale catalog sizes", () => {
		expect(
			buildQuantTooltipContent(
				entry({
					download: {
						downloadedBytes: 2_000,
						paused: false,
						progress: 100,
						totalBytes: 1_500,
					},
					downloadSizeBytes: 512,
					tooltip: "",
				}),
				null,
			),
		).toBe("q4_K_M\nStatus: Not downloaded\nDownload size: 2.0 KB");
	});

	test("uncached badge clicks start that quant download without selecting the parent card", () => {
		const { onCardClick, onCardPointerDown, onDownloadAction, onSelect } =
			renderInClickableCard(entry());

		const badge = screen.getByLabelText("Download q4_K_M weights");
		fireEvent.pointerDown(badge);
		fireEvent.click(badge);

		expect(onCardPointerDown).not.toHaveBeenCalled();
		expect(onCardClick).not.toHaveBeenCalled();
		expect(onDownloadAction).toHaveBeenCalledWith(
			"start",
			"gemma3",
			"gemma3:4b-q4_K_M",
		);
		expect(onSelect).not.toHaveBeenCalled();
	});

	test("cached badge clicks select that quant without selecting the parent card", () => {
		const { onCardClick, onCardPointerDown, onDownloadAction, onSelect } =
			renderInClickableCard(
				entry({
					cacheState: "cached",
					cacheStatusLabel: "Installed",
					canStartDownload: false,
				}),
			);

		const badge = screen.getByLabelText("Select q4_K_M precision");
		fireEvent.pointerDown(badge);
		fireEvent.click(badge);

		expect(onCardPointerDown).not.toHaveBeenCalled();
		expect(onCardClick).not.toHaveBeenCalled();
		expect(onSelect).toHaveBeenCalledWith("gemma3", "gemma3:4b-q4_K_M");
		expect(onDownloadAction).not.toHaveBeenCalled();
	});

	test("partial badge shows stored percent and resumes without selecting the parent card", () => {
		const { onCardClick, onCardPointerDown, onDownloadAction, onSelect } =
			renderInClickableCard(
				entry({
					cacheState: "partial",
					cacheProgress: 0.42,
					cacheStatusLabel: "42% downloaded",
					canResumeDownload: true,
					canStartDownload: false,
				}),
			);

		const badge = screen.getByLabelText("Resume q4_K_M weights download");
		expect(screen.getByText("42%")).toBeDefined();
		expect(screen.getByLabelText("Cancel q4_K_M download")).toBeDefined();
		fireEvent.pointerDown(badge);
		fireEvent.click(badge);

		expect(onCardPointerDown).not.toHaveBeenCalled();
		expect(onCardClick).not.toHaveBeenCalled();
		expect(onDownloadAction).toHaveBeenCalledWith(
			"resume",
			"gemma3",
			"gemma3:4b-q4_K_M",
		);
		expect(onSelect).not.toHaveBeenCalled();
	});
});

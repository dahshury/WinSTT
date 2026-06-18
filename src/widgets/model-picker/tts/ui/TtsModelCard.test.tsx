import { describe, expect, mock, test } from "bun:test";
import { Combobox } from "@base-ui/react/combobox";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TtsModelInfo, TtsModelState } from "@/entities/tts-catalog";
import { type QuantDownloadSnapshot, TtsModelCard } from "./TtsModelCard";

/** A fully-typed TTS model with sane defaults; each test overrides only what it
 *  cares about. TTS models ship a SINGLE precision — the regression this guards
 *  is that a one-quant model still surfaces its lone download badge. */
function makeModel(overrides: Partial<TtsModelInfo> = {}): TtsModelInfo {
	return {
		id: "kokoro-82m",
		displayName: "Kokoro 82M",
		engine: "kokoro",
		maker: "hexgrad",
		languages: ["en-us"],
		numVoices: 54,
		cloning: "none",
		sampleRate: 24_000,
		paramCountM: 82,
		availableQuantizations: ["fp16"],
		sizeBytesByQuantization: { fp16: 169_869_312 },
		sizeLabel: "82M",
		qualityScore: 0.9,
		speedScore: 0.85,
		description:
			"Best everyday local voice set; natural read-aloud across many languages.",
		available: true,
		...overrides,
	};
}

function makeState(
	state: "cached" | "partial" | "not_cached",
	progress = state === "cached" ? 1 : 0,
): TtsModelState {
	return {
		id: "kokoro-82m",
		effectiveQuantization: "fp16",
		estimatedBytes: 169_869_312,
		cacheByQuantization: {
			fp16: { state, downloadedBytes: 0, totalBytes: 0, progress },
		},
	};
}

function renderCard(opts: {
	model?: TtsModelInfo;
	snapshot?: QuantDownloadSnapshot | undefined;
	state?: TtsModelState | undefined;
}) {
	const onSelect = mock(() => undefined);
	const onDownloadAction = mock(() => undefined);
	const model = opts.model ?? makeModel();
	const utils = render(
		<TooltipProvider.Provider>
			<Combobox.Root items={[model]}>
				<Combobox.List>
					{() => (
						<TtsModelCard
							currentQuantization=""
							getDownloadSnapshot={() => opts.snapshot}
							key={model.id}
							model={model}
							onDownloadAction={onDownloadAction}
							onSelect={onSelect}
							selectedId={undefined}
							state={opts.state}
						/>
					)}
				</Combobox.List>
			</Combobox.Root>
		</TooltipProvider.Provider>,
	);
	return { ...utils, onSelect, onDownloadAction };
}

describe("TtsModelCard description", () => {
	test("renders the catalog description", () => {
		renderCard({
			model: makeModel({
				description: "Warm multilingual voices for everyday read-aloud.",
			}),
		});

		expect(
			screen.getByText("Warm multilingual voices for everyday read-aloud."),
		).toBeDefined();
	});
});

describe("TtsModelCard precision-badge download affordance (single-quant models)", () => {
	test("card meta shows the catalog size — a known size is never overridden by a runtime total", () => {
		// The download size is a static, known fact. With a catalog size present,
		// no in-flight/aggregate runtime number may override it (that override is
		// what let a partial download masquerade as the model's size).
		renderCard({
			model: makeModel({ sizeBytesByQuantization: { fp16: 83_886_080 } }),
			snapshot: {
				downloadedBytes: 191_959_988,
				paused: false,
				progress: 100,
				totalBytes: 191_959_988,
			},
			state: makeState("not_cached"),
		});
		expect(screen.getByText("80 MB")).toBeDefined();
		expect(screen.queryByText("183 MB")).toBeNull();
	});

	test("card meta falls back to the live total only when the catalog ships no size", () => {
		renderCard({
			model: makeModel({ sizeBytesByQuantization: {} }),
			snapshot: {
				downloadedBytes: 191_959_988,
				paused: false,
				progress: 100,
				totalBytes: 191_959_988,
			},
			state: makeState("not_cached"),
		});
		expect(screen.getByText("183 MB")).toBeDefined();
	});

	test("a single uncached precision still renders a download badge", () => {
		const { onDownloadAction } = renderCard({ state: makeState("not_cached") });
		// The lone fp16 badge IS the download trigger — the shelf must NOT hide
		// itself just because the model ships one precision.
		const trigger = screen.getByLabelText("Download fp16 weights");
		expect(trigger).toBeDefined();
		fireEvent.click(trigger);
		expect(onDownloadAction).toHaveBeenCalledWith(
			"start",
			"kokoro-82m",
			"fp16",
		);
	});

	test("a downloading badge shows live progress + pause/cancel", () => {
		const { container } = renderCard({
			snapshot: {
				downloadedBytes: 5,
				paused: false,
				progress: 50,
				totalBytes: 10,
			},
			state: makeState("not_cached"),
		});
		expect(screen.getByText("50%")).toBeDefined();
		expect(container.querySelector(".t-digit-group")).toBeNull();
		expect(screen.getByLabelText("Pause fp16 download")).toBeDefined();
		expect(screen.getByLabelText("Cancel fp16 download")).toBeDefined();
		expect(screen.queryByLabelText("Download fp16 weights")).toBeNull();
	});

	test("a partial precision shows stored progress and resumes before a live snapshot exists", () => {
		const { onDownloadAction, onSelect } = renderCard({
			state: makeState("partial", 0.64),
		});
		expect(screen.getByText("64%")).toBeDefined();
		fireEvent.click(screen.getByLabelText("Resume fp16 weights download"));
		expect(onDownloadAction).toHaveBeenCalledWith(
			"resume",
			"kokoro-82m",
			"fp16",
		);
		expect(onSelect).not.toHaveBeenCalled();
	});

	test("a cached badge selects (not downloads) at that precision", () => {
		const { onSelect, onDownloadAction } = renderCard({
			state: makeState("cached"),
		});
		fireEvent.click(screen.getByLabelText("Select fp16 precision"));
		expect(onSelect).toHaveBeenCalledWith("kokoro-82m", "fp16");
		expect(onDownloadAction).not.toHaveBeenCalled();
	});
});

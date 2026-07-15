import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@/shared/ui/model-picker/test/render-with-intl";
import { OllamaQuantShelf } from "./OllamaQuantShelf";

describe("OllamaQuantShelf", () => {
	test("dedupes alias tags that resolve to the same installed model", () => {
		const originalError = console.error;
		const consoleError = mock(() => undefined);
		console.error = consoleError;
		try {
			render(
				<OllamaQuantShelf
					getFit={undefined}
					installedNames={new Set(["gemma4:e4b"])}
					onDiscard={mock(() => undefined)}
					onPull={mock(() => undefined)}
					onResume={mock(() => undefined)}
					onSelect={mock(() => undefined)}
					onStop={mock(() => undefined)}
					paramSize="e4b"
					pausedPulls={{}}
					pulls={{}}
					selectedName="gemma4:e4b"
					tags={[
						{
							name: "gemma4:e4b",
							parameterSize: "e4b",
							sizeBytes: 9_600_000_000,
						},
						{
							name: "gemma4:e4b-it-q4_K_M",
							parameterSize: "e4b",
							quantization: "Q4_K_M",
							sizeBytes: 9_600_000_000,
						},
					]}
				/>,
			);
		} finally {
			console.error = originalError;
		}

		expect(screen.getAllByLabelText("Select Q4_K_M precision")).toHaveLength(1);
		expect(screen.queryByLabelText("Select default precision")).toBeNull();
		const messages = consoleError.mock.calls
			.map((args) => args.map(String).join(" "))
			.join("\n");
		expect(messages).not.toContain(
			"Encountered two children with the same key",
		);
	});

	test("measures download progress against the quant's full size, not the per-layer percent", () => {
		// Ollama streams layers sequentially; its aggregate `percent` is computed
		// against a denominator that grows as each new layer is announced. Here the
		// first layer (500 of a 1000-byte model) is complete, so Ollama reports
		// percent=100 for that layer — but the WHOLE download is only 50% done. The
		// badge must render 50% (completed / known full size), never 100%, so the bar
		// doesn't sit pinned/"reset" when the next file starts.
		render(
			<OllamaQuantShelf
				getFit={undefined}
				installedNames={new Set()}
				onDiscard={mock(() => undefined)}
				onPull={mock(() => undefined)}
				onResume={mock(() => undefined)}
				onSelect={mock(() => undefined)}
				onStop={mock(() => undefined)}
				paramSize="135m"
				pausedPulls={{}}
				pulls={{
					"smollm2:135m": {
						model: "smollm2:135m",
						status: "downloading",
						completed: 500,
						total: 500,
						percent: 100,
					},
				}}
				selectedName={undefined}
				tags={[{ name: "smollm2:135m", sizeBytes: 1000 }]}
			/>,
		);

		expect(screen.getByText("50%")).toBeDefined();
		expect(screen.queryByText("100%")).toBeNull();
	});

	test("disables tags outside the Suggested fitting set with the memory tooltip", () => {
		render(
			<OllamaQuantShelf
				getFit={undefined}
				installedNames={new Set()}
				onDiscard={mock(() => undefined)}
				onPull={mock(() => undefined)}
				onResume={mock(() => undefined)}
				onSelect={mock(() => undefined)}
				onStop={mock(() => undefined)}
				paramSize="27b"
				pausedPulls={{}}
				pulls={{}}
				selectedName={undefined}
				suggestedFits={(sizeBytes) => sizeBytes < 20_000_000_000}
				tags={[
					{
						name: "gemma3:27b-q4_K_M",
						parameterSize: "27b",
						quantization: "Q4_K_M",
						sizeBytes: 17_000_000_000,
					},
					{
						name: "gemma3:27b-q8_0",
						parameterSize: "27b",
						quantization: "Q8_0",
						sizeBytes: 29_000_000_000,
					},
				]}
			/>,
		);

		// The unfit tag stops advertising a download (label reverts to "Select…")
		// and renders aria-disabled; the fitting tag keeps its download affordance.
		const q8 = screen.getByLabelText("Select Q8_0 precision");
		const q4 = screen.getByLabelText("Download Q4_K_M weights");
		expect(q8.getAttribute("aria-disabled")).toBe("true");
		expect(q4.getAttribute("aria-disabled")).not.toBe("true");
	});

	test("keeps GPT-OSS MXFP4 visible when Suggested marks it unfit", () => {
		render(
			<OllamaQuantShelf
				getFit={undefined}
				installedNames={new Set()}
				onDiscard={mock(() => undefined)}
				onPull={mock(() => undefined)}
				onResume={mock(() => undefined)}
				onSelect={mock(() => undefined)}
				onStop={mock(() => undefined)}
				paramSize="20b"
				pausedPulls={{}}
				pulls={{}}
				selectedName={undefined}
				suggestedFits={() => false}
				tags={[
					{
						name: "gpt-oss:20b",
						parameterSize: "20B",
						sizeBytes: 14_000_000_000,
					},
				]}
			/>,
		);

		const badge = screen.getByLabelText("Select MXFP4 precision");
		expect(badge.getAttribute("aria-disabled")).toBe("true");
	});

	test("no tag is disabled when the Suggested fit is not wired (flag off / no verdict)", () => {
		render(
			<OllamaQuantShelf
				getFit={undefined}
				installedNames={new Set()}
				onDiscard={mock(() => undefined)}
				onPull={mock(() => undefined)}
				onResume={mock(() => undefined)}
				onSelect={mock(() => undefined)}
				onStop={mock(() => undefined)}
				paramSize="27b"
				pausedPulls={{}}
				pulls={{}}
				selectedName={undefined}
				tags={[
					{
						name: "gemma3:27b-q8_0",
						parameterSize: "27b",
						quantization: "Q8_0",
						sizeBytes: 29_000_000_000,
					},
				]}
			/>,
		);

		const badge = screen.getByLabelText("Download Q8_0 weights");
		expect(badge.getAttribute("aria-disabled")).not.toBe("true");
	});

	test("pins to 100% on the success frame even if the full size is slightly off", () => {
		render(
			<OllamaQuantShelf
				getFit={undefined}
				installedNames={new Set()}
				onDiscard={mock(() => undefined)}
				onPull={mock(() => undefined)}
				onResume={mock(() => undefined)}
				onSelect={mock(() => undefined)}
				onStop={mock(() => undefined)}
				paramSize="135m"
				pausedPulls={{}}
				pulls={{
					"smollm2:135m": {
						model: "smollm2:135m",
						status: "success",
						completed: 980,
						total: 980,
						percent: 100,
					},
				}}
				selectedName={undefined}
				tags={[{ name: "smollm2:135m", sizeBytes: 1000 }]}
			/>,
		);

		expect(screen.getByText("100%")).toBeDefined();
	});
});

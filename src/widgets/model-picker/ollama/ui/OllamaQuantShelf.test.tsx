import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "../../test/render-with-intl";
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

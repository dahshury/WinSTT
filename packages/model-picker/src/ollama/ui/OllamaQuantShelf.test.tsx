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
});

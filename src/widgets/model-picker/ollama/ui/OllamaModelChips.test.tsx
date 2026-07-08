import { describe, expect, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render } from "../../test/render-with-intl";
import { InstalledCapabilityBadges } from "./OllamaModelChips";

function renderCapabilityBadges(
	capabilities: readonly string[],
	compact = false,
) {
	return render(
		<TooltipProvider.Provider>
			<InstalledCapabilityBadges
				capabilities={capabilities}
				compact={compact}
			/>
		</TooltipProvider.Provider>,
	);
}

describe("installedCapabilityBadges", () => {
	test("renders styled badges for tools, thinking, and visible Ollama capabilities", () => {
		const { container } = renderCapabilityBadges([
			"tools",
			"thinking",
			"vision",
			"completion",
		]);
		const text = container.textContent ?? "";
		expect(text).toContain("FN");
		expect(text).toContain("Reasoning");
		expect(text).toContain("Vision");
		expect(text).not.toContain("thinking");
		expect(text).not.toContain("completion");
	});

	test("compact badges render icon-only labels with accessible hover targets", () => {
		const { container } = renderCapabilityBadges(
			["tools", "thinking", "vision", "completion"],
			true,
		);
		const text = container.textContent ?? "";
		expect(text).not.toContain("FN");
		expect(text).not.toContain("Reasoning");
		expect(text).not.toContain("Vision");
		expect(
			container.querySelector('[data-feature-key="tools"]'),
		).not.toBeNull();
		expect(container.querySelector('[aria-label="Reasoning"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Vision"]')).not.toBeNull();
	});

	test("renders nothing when capabilities are empty or only completion", () => {
		expect(renderCapabilityBadges([]).container.firstChild).toBeNull();
		expect(
			renderCapabilityBadges(["completion"]).container.firstChild,
		).toBeNull();
	});
});

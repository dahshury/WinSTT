import { describe, expect, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render } from "../../test/render-with-intl";
import { installedCapabilityBadges } from "./OllamaModelChips";

function renderCapabilityBadges(capabilities: readonly string[]) {
	return render(
		<TooltipProvider.Provider>
			{installedCapabilityBadges(capabilities)}
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

	test("renders nothing when capabilities are empty or only completion", () => {
		expect(renderCapabilityBadges([]).container.firstChild).toBeNull();
		expect(
			renderCapabilityBadges(["completion"]).container.firstChild,
		).toBeNull();
	});
});

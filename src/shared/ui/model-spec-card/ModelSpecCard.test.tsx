import { GlobeIcon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { render } from "@testing-library/react";
import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { ModelSpecCard } from "./ModelSpecCard";
import { ModelSpecHoverCard } from "./ModelSpecHoverCard";
import type { ModelSpec } from "./types";

// The card's section eyebrows resolve through `useTranslations`, so every render
// needs an intl context. The test preload swaps in a synchronous English
// provider (see `test/mocks/intl-provider.tsx`).
function renderCard(ui: ReactNode) {
	return render(<IntlProvider>{ui}</IntlProvider>);
}

const FULL: ModelSpec = {
	name: "Kimi K2",
	variant: "0905",
	makerLabel: "Moonshot AI",
	description: "Enhanced version with longer context.",
	priceTier: 2,
	priceLabel: "$3 in · $15 out / M tokens",
	features: [
		{ key: "reasoning", icon: GlobeIcon, label: "Reasoning" },
		{ key: "tools", icon: Wrench01Icon, label: "Tool calling" },
	],
	facts: [
		{ key: "provider", label: "Provider", value: "OpenRouter" },
		{ key: "knowledge", label: "Knowledge cutoff", value: "Dec 2024" },
	],
	stats: [{ key: "quality", label: "Quality", score: 0.82 }],
	sourceLabel: "via models.dev",
};

describe("ModelSpecCard", () => {
	test("renders identity, sections, facts, stats and source", () => {
		const { container } = renderCard(<ModelSpecCard spec={FULL} />);
		const text = container.textContent ?? "";
		expect(text).toContain("Kimi K2");
		expect(text).toContain("Moonshot AI");
		expect(text).toContain("Enhanced version");
		expect(text).toContain("Reasoning");
		expect(text).toContain("Tool calling");
		expect(text).toContain("OpenRouter");
		expect(text).toContain("Dec 2024");
		expect(text).toContain("Quality");
		expect(text).toContain("82%");
		expect(text).toContain("$$"); // tier-2 price chip
		expect(text).toContain("via models.dev");
	});

	test("omits empty sections", () => {
		const { container } = renderCard(
			<ModelSpecCard spec={{ name: "Bare Model", features: [], facts: [] }} />,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("Bare Model");
		expect(text).not.toContain("Description");
		expect(text).not.toContain("Features");
		expect(text).not.toContain("Details");
		expect(text).not.toContain("Performance");
	});

	test("shows a loading hint instead of a source label while enriching", () => {
		const { container } = renderCard(
			<ModelSpecCard
				spec={{ name: "M", features: [], facts: [], loading: true }}
			/>,
		);
		expect(container.textContent ?? "").toContain("Loading details");
	});
});

describe("ModelSpecHoverCard", () => {
	test("is inert (renders only the child) when spec is null", () => {
		const { getByTestId, container } = render(
			<ModelSpecHoverCard spec={null}>
				<span data-testid="anchor">Model X</span>
			</ModelSpecHoverCard>,
		);
		expect(getByTestId("anchor").textContent).toBe("Model X");
		// No card content is rendered when there is no spec.
		expect(container.textContent).toBe("Model X");
	});

	test("renders the anchor as the trigger when given a spec (popup stays closed until hover)", () => {
		const { getByTestId } = render(
			<ModelSpecHoverCard spec={FULL}>
				<span data-testid="anchor">Kimi K2</span>
			</ModelSpecHoverCard>,
		);
		expect(getByTestId("anchor")).toBeDefined();
	});
});

import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { ModelSettingsPanel } from "./ModelSettingsPanel";

describe("ModelSettingsPanel", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});

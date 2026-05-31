import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { SettingsPage } from "./SettingsPage";

describe("SettingsPage", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<SettingsPage />
			</IntlProvider>
		);
		expect(container).not.toBeNull();
	});
});

import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { TrayMenuPage } from "./TrayMenuPage";

describe("TrayMenuPage", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<TrayMenuPage />
			</IntlProvider>
		);
		expect(container).not.toBeNull();
	});
});

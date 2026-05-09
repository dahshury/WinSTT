import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { OverlayPage } from "./OverlayPage";

describe("OverlayPage", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<OverlayPage />
			</IntlProvider>
		);
		expect(container).not.toBeNull();
	});
});

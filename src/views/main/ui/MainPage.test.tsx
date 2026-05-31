import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { MainPage } from "./MainPage";

describe("MainPage", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<MainPage />
			</IntlProvider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});

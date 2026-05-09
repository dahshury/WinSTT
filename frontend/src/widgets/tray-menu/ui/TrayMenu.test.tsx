import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { TrayMenu } from "./TrayMenu";

describe("TrayMenu", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});

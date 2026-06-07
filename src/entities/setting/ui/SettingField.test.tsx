import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { SettingField } from "./SettingField";

function renderField(ui: React.ReactElement) {
	return render(<IntlProvider>{ui}</IntlProvider>);
}

const RESET = "Reset to default";

describe("SettingField", () => {
	test("renders no reset button when onReset is omitted", () => {
		renderField(<SettingField label="Speed" />);
		expect(screen.queryByRole("button", { name: RESET })).toBeNull();
	});

	test("renders a reset button when onReset is provided", () => {
		renderField(<SettingField label="Speed" onReset={() => undefined} />);
		expect(screen.getByRole("button", { name: RESET })).toBeDefined();
	});

	test("reset button is disabled while value equals defaultValue", () => {
		renderField(
			<SettingField
				defaultValue="a"
				label="Speed"
				onReset={() => undefined}
				value="a"
			/>,
		);
		expect(
			screen.getByRole("button", { name: RESET }).hasAttribute("disabled"),
		).toBe(true);
	});

	test("reset button is enabled when value differs from defaultValue", () => {
		renderField(
			<SettingField
				defaultValue="a"
				label="Speed"
				onReset={() => undefined}
				value="b"
			/>,
		);
		expect(
			screen.getByRole("button", { name: RESET }).hasAttribute("disabled"),
		).toBe(false);
	});

	test("explicit isDefault overrides value/defaultValue comparison", () => {
		renderField(
			<SettingField
				defaultValue="a"
				isDefault
				label="Speed"
				onReset={() => undefined}
				value="b"
			/>,
		);
		expect(
			screen.getByRole("button", { name: RESET }).hasAttribute("disabled"),
		).toBe(true);
	});

	test("hideReset suppresses the reset button even with onReset", () => {
		renderField(
			<SettingField hideReset label="Speed" onReset={() => undefined} />,
		);
		expect(screen.queryByRole("button", { name: RESET })).toBeNull();
	});

	test("clicking reset opens the confirm dialog (does not fire onReset directly)", () => {
		const onReset = mock(() => undefined);
		renderField(
			<SettingField
				defaultValue="a"
				label="Speed"
				onReset={onReset}
				value="b"
			/>,
		);
		screen.getByRole("button", { name: RESET }).click();
		// The reset is gated behind a ConfirmDialog — the click opens it, the
		// actual onReset fires on confirm (covered by SettingResetButton).
		expect(onReset).toHaveBeenCalledTimes(0);
	});
});

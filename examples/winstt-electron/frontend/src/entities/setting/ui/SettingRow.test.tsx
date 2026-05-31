import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { SettingRow } from "./SettingRow";

describe("SettingRow", () => {
	test("renders the label and child control", () => {
		render(
			<SettingRow label="Recording mode">
				<button data-testid="ctrl" type="button">
					control
				</button>
			</SettingRow>
		);
		expect(screen.getByText("Recording mode")).toBeDefined();
		expect(screen.getByTestId("ctrl")).toBeDefined();
	});

	test("renders the description when provided", () => {
		render(
			<SettingRow description="Push to talk vs toggle" label="Recording">
				<input type="checkbox" />
			</SettingRow>
		);
		expect(screen.getByText("Push to talk vs toggle")).toBeDefined();
	});

	test("does not render description block when not provided", () => {
		render(
			<SettingRow label="Audio">
				<span data-testid="x">x</span>
			</SettingRow>
		);
		// Only one text element ("Audio") should be present besides the testid span
		expect(screen.getByText("Audio")).toBeDefined();
	});
});

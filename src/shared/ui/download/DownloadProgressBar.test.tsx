import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { DownloadProgressBar } from "./DownloadProgressBar";

describe("DownloadProgressBar", () => {
	test("animates numeric progress captions with digit pop-in hooks", () => {
		const { container } = render(
			<DownloadProgressBar
				label="45%"
				percent={45}
				statsLabel="12 MB / 30 MB"
				variant="active"
			/>,
		);

		expect(container.querySelector(".t-digit-group")?.textContent).toContain(
			"45",
		);
		expect(container.querySelectorAll(".t-digit").length).toBeGreaterThan(0);
	});

	test("animates non-numeric status captions with text-swap hooks", () => {
		const { container } = render(
			<DownloadProgressBar
				label="Starting download"
				percent={null}
				variant="active"
			/>,
		);

		expect(container.querySelector(".t-text-swap")?.textContent).toBe(
			"Starting download",
		);
	});
});

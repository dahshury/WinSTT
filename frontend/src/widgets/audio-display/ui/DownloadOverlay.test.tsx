import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useDownloadStore } from "@/features/model-download";
import { DownloadOverlay } from "./DownloadOverlay";

beforeEach(() => {
	useDownloadStore.setState({
		isDownloading: false,
		modelName: null,
		progress: null,
		downloadedBytes: 0,
		totalBytes: 0,
		speedBps: 0,
		etaSeconds: 0,
		cancelled: false,
	});
});

afterEach(() => {
	useDownloadStore.setState({
		isDownloading: false,
		modelName: null,
		progress: null,
	});
});

describe("DownloadOverlay", () => {
	test("renders nothing visible when no download is active", () => {
		const { container } = render(
			<IntlProvider>
				<DownloadOverlay />
			</IntlProvider>
		);
		// The overlay short-circuits when not downloading — body is empty or near-empty
		expect(container.textContent ?? "").toBe("");
	});

	test("renders the overlay UI with model name when downloading", () => {
		useDownloadStore.setState({
			isDownloading: true,
			modelName: "tiny",
			progress: 50,
			downloadedBytes: 100,
			totalBytes: 200,
			speedBps: 1024,
			etaSeconds: 10,
		});
		const { container } = render(
			<IntlProvider>
				<DownloadOverlay />
			</IntlProvider>
		);
		expect(container.textContent).toContain("tiny");
	});
});

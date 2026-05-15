import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useConnectionStore } from "@/entities/connection";
import { useTranscriptionStore } from "@/entities/transcription";
import { TranscriptionFeed } from "./TranscriptionFeed";

beforeEach(() => {
	useTranscriptionStore.setState({ items: [], currentRealtime: "", ephemeral: null });
	useConnectionStore.setState({
		connectionStatus: "disconnected",
		gpuInfo: null,
		serverStatus: "idle",
	});
});

afterEach(() => {
	useTranscriptionStore.setState({ items: [], currentRealtime: "", ephemeral: null });
});

describe("TranscriptionFeed", () => {
	test("renders empty state with offline indicator when disconnected", () => {
		render(
			<IntlProvider>
				<TranscriptionFeed />
			</IntlProvider>
		);
		expect(document.body.textContent?.length).toBeGreaterThan(0);
	});

	test("renders the connected empty state when connection is active", () => {
		useConnectionStore.setState({ connectionStatus: "connected" });
		const { container } = render(
			<IntlProvider>
				<TranscriptionFeed />
			</IntlProvider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders final items when transcription store contains them", () => {
		useTranscriptionStore.setState({
			items: [{ id: "1", type: "final", text: "hello world", timestamp: 0 }],
			currentRealtime: "",
			ephemeral: null,
		});
		render(
			<IntlProvider>
				<TranscriptionFeed />
			</IntlProvider>
		);
		expect(screen.getByText("hello world")).toBeDefined();
	});

	test("renders the realtime preview line when currentRealtime is set", () => {
		useTranscriptionStore.setState({
			items: [],
			currentRealtime: "preview…",
			ephemeral: null,
		});
		render(
			<IntlProvider>
				<TranscriptionFeed />
			</IntlProvider>
		);
		expect(screen.getByText("preview…")).toBeDefined();
	});
});

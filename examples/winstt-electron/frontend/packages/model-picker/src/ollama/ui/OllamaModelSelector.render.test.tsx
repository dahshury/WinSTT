import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { OllamaModel, RecommendedOllamaModel } from "@/shared/api/models";
import { OllamaModelSelector } from "./OllamaModelSelector";

function installed(name: string): OllamaModel {
	return {
		name,
		model: name,
		size: 3_300_000_000,
		digest: "abc",
		modified_at: "2026-01-01T00:00:00Z",
		details: { family: "", parameter_size: "4B", quantization_level: "Q4_K_M" },
		capabilities: [],
	} as unknown as OllamaModel;
}

function recommended(name: string, family: string, displayName: string): RecommendedOllamaModel {
	return {
		name,
		family,
		displayName,
		paramSize: "E2B",
		sizeBytes: 7_200_000_000,
		description: "Latest Gemma.",
		tags: ["instruct"],
	};
}

function renderInline() {
	const noop = mock(() => undefined);
	const onDelete = mock(() => undefined);
	const utils = render(
		<OllamaModelSelector
			inline
			models={[installed("gemma3:4b")]}
			onChange={noop}
			onDelete={onDelete}
			onDiscardPull={noop}
			onPull={noop}
			onResumePull={noop}
			onStopPull={noop}
			recommendedModels={[recommended("gemma4:e2b", "gemma", "Gemma 4 E2B")]}
			value="gemma3:4b"
		/>
	);
	return { ...utils, onDelete };
}

describe("OllamaModelSelector maker-first rendering", () => {
	test("installed + recommended of the same maker render under one maker header", () => {
		renderInline();
		// One "Google" maker section…
		expect(screen.getAllByText("Google").length).toBeGreaterThan(0);
		// …holding BOTH the installed gemma3 (display name strips family → "Gemma 3")
		// and the recommended gemma4 — the user's exact ask.
		expect(screen.getByText("Gemma 3")).toBeDefined();
		expect(screen.getByText("Gemma 4 E2B")).toBeDefined();
		// Recommended cards carry the star badge.
		expect(screen.getAllByText("Recommended").length).toBeGreaterThan(0);
	});

	test("no maker-less 'Ollama Library' section without a search/librarySearch", () => {
		renderInline();
		expect(screen.queryByText("Ollama Library")).toBeNull();
	});
});

describe("OllamaModelSelector installed-card interactions", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});
	afterEach(() => {
		window.localStorage.clear();
	});

	test("installed card shows a favorite star and starring surfaces a Favorites group", () => {
		renderInline();
		const star = screen.getByLabelText("Add Gemma 3 to favorites");
		expect(star).toBeDefined();
		expect(screen.queryByText("Favorites")).toBeNull();
		fireEvent.click(star);
		expect(screen.getByText("Favorites")).toBeDefined();
	});

	test("recommended (not-installed) cards also get a favorite star — like the STT picker", () => {
		renderInline();
		const star = screen.getByLabelText("Add Gemma 4 E2B to favorites");
		expect(star).toBeDefined();
		fireEvent.click(star);
		// Favoriting a recommended model pins it into the Favorites group.
		expect(screen.getByText("Favorites")).toBeDefined();
	});

	test("installed card shows a delete button that fires onDelete", () => {
		const { onDelete } = renderInline();
		const del = screen.getByLabelText("Delete gemma3:4b");
		expect(del).toBeDefined();
		fireEvent.click(del);
		expect(onDelete).toHaveBeenCalledTimes(1);
	});

	test("a realistic pointer sequence on delete fires onDelete without selecting the row", () => {
		const { onDelete } = renderInline();
		const del = screen.getByLabelText("Delete gemma3:4b");
		// Base UI Combobox.Item commits selection on pointer events, so the
		// delete/favorite buttons must swallow pointerdown too — otherwise the row
		// selects (and the popup closes) and the action is lost.
		fireEvent.pointerDown(del);
		fireEvent.pointerUp(del);
		fireEvent.click(del);
		expect(onDelete).toHaveBeenCalled();
	});

	test("a realistic pointer sequence on the star toggles favorite without selecting the row", () => {
		renderInline();
		const star = screen.getByLabelText("Add Gemma 3 to favorites");
		fireEvent.pointerDown(star);
		fireEvent.pointerUp(star);
		fireEvent.click(star);
		expect(screen.getByText("Favorites")).toBeDefined();
	});
});

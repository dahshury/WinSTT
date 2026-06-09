import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { OllamaModel } from "@/shared/api/models";
import { OllamaModelSelector } from "./OllamaModelSelector";

function model(): OllamaModel {
	return {
		name: "llama3:8b",
		size: 4_700_000_000,
		modifiedAt: "2026-01-01T00:00:00Z",
		details: { family: "llama" },
		capabilities: [],
	} as OllamaModel;
}

describe("OllamaModelSelector detached-open mode", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	test("onOpenDetached opens the detached picker without opening the in-page popup", () => {
		const onOpenDetached = mock(() => undefined);
		const onChange = mock(() => undefined);
		render(
			<OllamaModelSelector
				models={[model()]}
				onChange={onChange}
				onOpenDetached={onOpenDetached}
				value="llama3:8b"
			/>,
		);

		const trigger = document.querySelector(
			'[data-slot="ollama-model-selector-trigger"]',
		);
		expect(trigger).not.toBeNull();

		fireEvent.click(trigger as Element);

		expect(onOpenDetached).toHaveBeenCalledTimes(1);
		expect(trigger.getAttribute("data-state")).toBe("closed");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	test("inline detached mode restores persisted search query for its scoped key", () => {
		const uiStorageKey = "winstt:test:ollama-inline-ui";
		window.localStorage.setItem(
			uiStorageKey,
			JSON.stringify({
				activeRailId: "llama",
				query: "llama3",
				sortKey: null,
			}),
		);

		render(
			<OllamaModelSelector
				inline
				models={[model()]}
				onChange={() => undefined}
				uiStorageKey={uiStorageKey}
				value="llama3:8b"
			/>,
		);

		const search = screen.getByPlaceholderText(
			"Search models or enter an Ollama tag",
		) as HTMLInputElement;
		expect(search.value).toBe("llama3");
	});
});

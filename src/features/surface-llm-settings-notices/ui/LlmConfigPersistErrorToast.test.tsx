import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useConfigurationPersistenceErrorStore } from "@/widgets/llm-settings/model/configurations";
import { LlmConfigPersistErrorToast } from "./LlmConfigPersistErrorToast";

afterEach(() => {
	cleanup();
	useConfigurationPersistenceErrorStore.getState().clear();
});

function renderToast() {
	return render(
		<IntlProvider>
			<LlmConfigPersistErrorToast />
		</IntlProvider>,
	);
}

describe("LlmConfigPersistErrorToast", () => {
	test("renders nothing when no failure is queued", () => {
		const { container } = renderToast();
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	test("renders the storage-failure title for a save failure", () => {
		useConfigurationPersistenceErrorStore.getState().show({ action: "save" });
		renderToast();
		expect(screen.getByRole("alert")).toBeTruthy();
		// "storage" appears in both the title and the save body copy.
		expect(screen.getByText(/couldn't be written to storage/i)).toBeTruthy();
	});

	test("distinguishes the reorder failure body from the save body", () => {
		useConfigurationPersistenceErrorStore
			.getState()
			.show({ action: "reorder" });
		renderToast();
		expect(screen.getByText(/new order is applied/i)).toBeTruthy();
	});

	test("dismissing clears the store slot", () => {
		useConfigurationPersistenceErrorStore.getState().show({ action: "delete" });
		renderToast();
		fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
		expect(useConfigurationPersistenceErrorStore.getState().current).toBeNull();
	});
});

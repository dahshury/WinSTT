import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
	type RenderResult,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import type { PermissionPreflightStatus } from "@/bindings";
import { PermissionPreflightPanel } from "./PermissionPreflightPanel";

let rendered: RenderResult | null = null;

afterEach(() => {
	rendered?.unmount();
	rendered = null;
});

function renderPanel(
	status: PermissionPreflightStatus | null,
	overrides: Partial<
		React.ComponentProps<typeof PermissionPreflightPanel>
	> = {},
) {
	const props: React.ComponentProps<typeof PermissionPreflightPanel> = {
		busy: false,
		error: null,
		onRequestAccessibility: mock(() => undefined),
		onRequestMicrophone: mock(() => undefined),
		onRetry: mock(() => undefined),
		status,
		...overrides,
	};
	rendered = render(
		<IntlProvider>
			<PermissionPreflightPanel {...props} />
		</IntlProvider>,
	);
	return props;
}

describe("PermissionPreflightPanel", () => {
	test("shows only the platform requirements that apply", () => {
		renderPanel({
			platform: "windows",
			microphone: "required",
			accessibility: "not_required",
			ready: false,
		});

		expect(screen.getByText("Microphone access")).toBeTruthy();
		expect(screen.queryByText("Accessibility access")).toBeNull();
	});

	test("routes each missing permission to its focused request action", () => {
		const props = renderPanel({
			platform: "macos",
			microphone: "required",
			accessibility: "required",
			ready: false,
		});

		const buttons = screen.getAllByRole("button", { name: "Grant access" });
		expect(buttons).toHaveLength(2);
		fireEvent.click(buttons[0]!);
		fireEvent.click(buttons[1]!);

		expect(props.onRequestMicrophone).toHaveBeenCalledTimes(1);
		expect(props.onRequestAccessibility).toHaveBeenCalledTimes(1);
	});

	test("keeps an unknown preflight failure recoverable", () => {
		const onRetry = mock(() => undefined);
		renderPanel(null, { error: "native check failed", onRetry });

		expect(screen.getByText("native check failed")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});
});

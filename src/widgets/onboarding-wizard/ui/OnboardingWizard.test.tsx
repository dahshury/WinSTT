import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	type RenderResult,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { commands } from "@/bindings";
import { SurfaceProvider } from "@/shared/lib/surface";
import { useOnboardingWizardStore } from "../model/wizard-store";
import { OnboardingWizard } from "./OnboardingWizard";

interface TauriInvocation {
	args?: unknown;
	cmd: string;
}

let invocations: TauriInvocation[] = [];
let rendered: RenderResult | null = null;
const originalOnboardingFinish = commands.onboardingFinish;
const originalOpenWindow = commands.openWindow;

function resetWizardState(): void {
	useOnboardingWizardStore.setState({
		cloudSttReady: true,
		currentStep: "overview",
		hydratedFromSettings: true,
		micTestPassed: true,
		sttModelReady: true,
		track: "local",
	});
}

function renderWizard(): void {
	rendered = render(
		<IntlProvider>
			<SurfaceProvider value={1}>
				<div className="relative h-[640px] w-[720px]">
					<OnboardingWizard />
				</div>
			</SurfaceProvider>
		</IntlProvider>,
	);
}

beforeEach(async () => {
	cleanup();
	invocations = [];
	window.localStorage.clear();
	await useOnboardingWizardStore.persist.rehydrate();
	resetWizardState();
	commands.onboardingFinish = (async (args) => {
		invocations.push({ cmd: "onboarding_finish", args: { args } });
		return { status: "ok", data: null };
	}) satisfies typeof commands.onboardingFinish;
	commands.openWindow = (async (
		name,
		x,
		y,
		width,
		height,
		pickerKind,
		pickerFeature,
		pickerTarget,
	) => {
		invocations.push({
			cmd: "open_window",
			args: {
				name,
				x,
				y,
				width,
				height,
				pickerKind,
				pickerFeature,
				pickerTarget,
			},
		});
		return { status: "ok", data: null };
	}) satisfies typeof commands.openWindow;
});

afterEach(() => {
	commands.onboardingFinish = originalOnboardingFinish;
	commands.openWindow = originalOpenWindow;
	rendered?.unmount();
	rendered = null;
	resetWizardState();
	window.localStorage.clear();
	cleanup();
});

describe("OnboardingWizard", () => {
	test("overview settings links finish onboarding before opening the requested settings tab", async () => {
		renderWizard();

		fireEvent.click(
			screen.getAllByRole("button", {
				name: /Configure .* in Settings/,
			})[0]!,
		);

		await waitFor(() => {
			expect(invocations.some((call) => call.cmd === "open_window")).toBe(true);
		});

		const finishIndex = invocations.findIndex(
			(call) => call.cmd === "onboarding_finish",
		);
		const openIndex = invocations.findIndex(
			(call) =>
				call.cmd === "open_window" &&
				(call.args as { name?: string }).name === "settings",
		);

		expect(finishIndex).toBeGreaterThanOrEqual(0);
		expect(openIndex).toBeGreaterThan(finishIndex);
		expect(
			(
				invocations[finishIndex]?.args as {
					args?: { completed?: boolean; track?: string };
				}
			).args,
		).toEqual({ completed: true, track: "local" });
		expect(
			window.localStorage
				.getItem("winstt:pending-settings-section")
				?.startsWith("processing@"),
		).toBe(true);
		expect(useOnboardingWizardStore.getState().currentStep).toBe("welcome");
	});
});

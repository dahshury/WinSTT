import { Button as BaseButton } from "@base-ui/react/button";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import { commands } from "@/bindings";
import {
	type SettingsHydrationStatus,
	useSettingsHydrationStore,
	useSettingsStore,
} from "@/entities/setting";
import { useDownloadListener } from "@/features/model-download";
import { useSyncSettings } from "@/features/update-settings";
import { Elevated, SurfaceProvider } from "@/shared/lib/surface";
import { useTouchActivation } from "@/shared/lib/use-touch-activation";
import { useTransparentBody } from "@/shared/lib/window-effects";
import { Spinner } from "@/shared/ui/spinner";
import {
	OnboardingWizard,
	PermissionPreflightPanel,
	useOnboardingWizardStore,
} from "@/widgets/onboarding-wizard";
import { usePermissionPreflight } from "./use-permission-preflight";

function quitWinStt(): void {
	void commands.quitApp();
}

/**
 * First-run wizard view. Mirrors the SettingsPage shell so the window reads
 * as first-party WinSTT chrome rather than a tacked-on dialog:
 *
 *   - Transparent viewport gutter around the renderer-owned rounded shell,
 *     matching the Settings window's frameless card and CSS shadow.
 *   - No titlebar band: the close button floats in the content card's top-right
 *     corner and the thin gutter above the card remains draggable.
 *   - Body: the `settings-content-frame` + `settings-content-card` pair,
 *     identical to SettingsPage — a thin surface-1 gutter around an elevated
 *     surface-3 card (same bloom, ring, radius). Lifting to surface-3 makes
 *     the wizard's controls elevate to surface-5, the same chain every
 *     settings panel uses.
 *
 * `useSyncSettings()` is what makes the wizard's settings mutations (mic
 * device, API keys, LLM dictation enable + model) actually round-trip to
 * the main process's persisted store. Without it, those choices would live
 * only in this window's zustand store and disappear when the wizard closes.
 */
export function OnboardingPage() {
	useSyncSettings();
	useDownloadListener();
	useTransparentBody();
	const settings = useSettingsStore((s) => s.settings);
	const hydrationStatus = useSettingsHydrationStore((s) => s.status);
	const hydrationError = useSettingsHydrationStore((s) => s.error);
	const hydrateWizardFromSettings = useOnboardingWizardStore(
		(s) => s.hydrateFromSettings,
	);
	// Onboarding must be COMPLETED, not skipped: the titlebar control quits the
	// whole app rather than dismissing the wizard into the (un-onboarded) app.
	// Progress is persisted, so a relaunch resumes onboarding where it left off —
	// there is no "close to skip" path. (Alt+F4 / OS close is funnelled to the same
	// quit in the backend window-event handler.)
	const quitActivation = useTouchActivation(quitWinStt);
	const settingsReady = settingsReadyForWizard(hydrationStatus);
	const permission = usePermissionPreflight();

	useEffect(() => {
		if (settingsReady) {
			hydrateWizardFromSettings(settings);
		}
	}, [hydrateWizardFromSettings, settings, settingsReady]);

	return (
		<SurfaceProvider value={1}>
			<div className="flex h-dvh min-h-dvh p-5">
				<div className="noise-overlay settings-window-shell relative flex min-w-0 flex-1 overflow-hidden rounded-[1.35rem] shadow-settings-window ring-1 ring-divider-strong">
					{/* Content frame + card — the same renderer-owned shell Settings
					    uses. The transparent viewport gutter leaves room for the CSS
					    shadow without exposing a square native window. */}
					<div className="settings-content-frame relative min-w-0 flex-1 p-2">
						<div
							aria-hidden="true"
							className="titlebar-drag absolute inset-x-0 top-0 z-titlebar h-1.5"
						/>
						<Elevated
							className="settings-content-card relative flex h-full flex-col overflow-hidden rounded-[1.35rem] ring-1 ring-divider-strong"
							offset={2}
							shadowLevel={5}
						>
							<BaseButton
								aria-label="Quit WinSTT"
								className="titlebar-no-drag group absolute end-1.5 top-1.5 z-titlebar flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-4 text-foreground-muted outline-none transition-colors duration-150 hover:bg-error/85 hover:text-on-error focus-visible:ring-2 focus-visible:ring-accent"
								type="button"
								{...quitActivation}
							>
								<HugeiconsIcon
									className="transition-transform duration-150 ease-out group-hover:scale-110"
									icon={Cancel01Icon}
									size={15}
								/>
							</BaseButton>
							{permission.status?.ready && settingsReady ? (
								<OnboardingWizard />
							) : permission.status?.ready ? (
								<OnboardingSettingsHydrationState
									error={hydrationError}
									status={hydrationStatus}
								/>
							) : (
								<PermissionPreflightPanel
									busy={permission.busy}
									error={permission.error}
									onRequestAccessibility={() => {
										permission.request("accessibility");
									}}
									onRequestMicrophone={() => {
										permission.request("microphone");
									}}
									onRetry={permission.retry}
									status={permission.status}
								/>
							)}
						</Elevated>
					</div>
				</div>
			</div>
		</SurfaceProvider>
	);
}

function settingsReadyForWizard(status: SettingsHydrationStatus): boolean {
	return status === "ready" || status === "unavailable";
}

function OnboardingSettingsHydrationState({
	error,
	status,
}: {
	error: string | null;
	status: SettingsHydrationStatus;
}) {
	const isError = status === "error";
	return (
		<div className="flex flex-1 items-center justify-center px-6 text-center">
			<div className="flex max-w-sm flex-col items-center gap-2">
				<span className="flex size-9 items-center justify-center rounded-md bg-surface-4 text-foreground-muted ring-1 ring-divider">
					{isError ? (
						<HugeiconsIcon icon={Cancel01Icon} size={15} />
					) : (
						<Spinner className="size-4 border" />
					)}
				</span>
				<div className="font-semibold text-foreground text-title leading-tight">
					{isError ? "Settings could not be loaded" : "Loading saved settings"}
				</div>
				<p className="text-body-sm text-foreground-muted leading-snug">
					{isError
						? (error ?? "WinSTT could not read the persisted settings store.")
						: "WinSTT is reading your existing configuration before setup continues."}
				</p>
			</div>
		</div>
	);
}

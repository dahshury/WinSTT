import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/entities/setting";
import { useDownloadListener } from "@/features/model-download";
import {
	type SettingsHydrationStatus,
	useSettingsHydrationStore,
	useSyncSettings,
} from "@/features/update-settings";
import { publicAsset } from "@/shared/lib/public-asset";
import { Elevated, SurfaceProvider } from "@/shared/lib/surface";
import { useTouchActivation } from "@/shared/lib/use-touch-activation";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	OnboardingWizard,
	useOnboardingWizardStore,
} from "@/widgets/onboarding-wizard";

/**
 * First-run wizard view. Mirrors the SettingsPage shell so the window reads
 * as first-party WinSTT chrome rather than a tacked-on dialog:
 *
 *   - Page substrate: the shared `settings-window-shell` gradient + ambient
 *     noise overlay — the exact same field Settings paints behind its sidebar
 *     and content-card gutter.
 *   - Titlebar: 32px frameless bar, surface-2 (Elevated offset=1) with a
 *     Docker-blue hairline at the very top, the WinSTT app icon, mono-caps
 *     "WinSTT Setup" title, and a close button on the trailing edge that
 *     turns red on hover. The whole strip is draggable except the close.
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
	const t = useTranslations("onboarding");
	useSyncSettings();
	useDownloadListener();
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
	const quitActivation = useTouchActivation(() => {
		void commands.quitApp();
	});
	const settingsReady = settingsReadyForWizard(hydrationStatus);

	useEffect(() => {
		if (settingsReady) {
			hydrateWizardFromSettings(settings);
		}
	}, [hydrateWizardFromSettings, settings, settingsReady]);

	return (
		<SurfaceProvider value={1}>
			<div className="noise-overlay settings-window-shell flex h-dvh min-h-dvh flex-col bg-surface-1">
				{/* Title bar — surface-2 substrate with a top-light gradient
				    overlay, a Docker-blue accent hairline at the top edge
				    (single brand moment, matching Settings), and the WinSTT app
				    icon anchoring the title text (matching the main window). */}
				<Elevated
					className="titlebar-drag relative flex h-8 shrink-0 items-stretch border-border border-b bg-gradient-to-b from-[var(--color-surface-3)]/45 to-transparent"
					offset={1}
					shadowLevel={1}
				>
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent"
					/>
					<div className="flex items-center gap-2 pl-3">
						<img
							alt=""
							className="size-4"
							draggable={false}
							height={16}
							src={publicAsset("/icon.ico")}
							width={16}
						/>
						<span className="font-mono text-foreground-secondary text-xs-tight uppercase tracking-[0.18em]">
							{t("windowTitle")}
						</span>
					</div>
					<div className="flex-1" />
					<div className="titlebar-no-drag flex items-center">
						<Tooltip content="Quit WinSTT">
							<Button
								aria-label="Quit WinSTT"
								className="group flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 hover:bg-error/85 hover:text-on-error"
								{...quitActivation}
							>
								<HugeiconsIcon
									className="transition-transform duration-150 ease-out group-hover:scale-110"
									icon={Cancel01Icon}
									size={12}
								/>
							</Button>
						</Tooltip>
					</div>
				</Elevated>

				{/* Content frame + card — the SAME shell SettingsPage uses. A thin
				    surface-1 gutter (window-shell gradient flows through) wraps an
				    elevated surface-3 content card carrying the identical bloom,
				    ring, and 1.35rem radius. The surface-3 substrate is what lifts
				    every wizard control to surface-5, matching every settings panel. */}
				<div className="settings-content-frame relative min-w-0 flex-1 p-2">
					<Elevated
						className="settings-content-card relative flex h-full flex-col overflow-hidden rounded-[1.35rem] ring-1 ring-divider-strong"
						offset={2}
						shadowLevel={5}
					>
						{settingsReady ? (
							<OnboardingWizard />
						) : (
							<OnboardingSettingsHydrationState
								error={hydrationError}
								status={hydrationStatus}
							/>
						)}
					</Elevated>
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

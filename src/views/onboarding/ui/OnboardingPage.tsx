import { Button as BaseButton } from "@base-ui/react/button";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { commands, type PermissionPreflightStatus } from "@/bindings";
import {
	type SettingsHydrationStatus,
	useSettingsHydrationStore,
	useSettingsStore,
} from "@/entities/setting";
import { useDownloadListener } from "@/features/model-download";
import { useSyncSettings } from "@/features/update-settings";
import { Elevated, SurfaceProvider } from "@/shared/lib/surface";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";
import { useTouchActivation } from "@/shared/lib/use-touch-activation";
import { useTransparentBody } from "@/shared/lib/window-effects";
import { Spinner } from "@/shared/ui/spinner";
import {
	OnboardingWizard,
	PermissionPreflightPanel,
	useOnboardingWizardStore,
} from "@/widgets/onboarding-wizard";

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
	const quitActivation = useTouchActivation(() => {
		void commands.quitApp();
	});
	const settingsReady = settingsReadyForWizard(hydrationStatus);
	const [permissionStatus, setPermissionStatus] =
		useState<PermissionPreflightStatus | null>(null);
	const [permissionBusy, setPermissionBusy] = useState(true);
	const [permissionError, setPermissionError] = useState<string | null>(null);
	const awaitingGrantRef = useRef(false);
	const preflightInFlightRef =
		useRef<Promise<PermissionPreflightStatus | null> | null>(null);

	const acceptPermissionResult = useCallback(
		(result: Awaited<ReturnType<typeof commands.permissionRunPreflight>>) => {
			if (result.status === "error") {
				throw new Error(result.error);
			}
			setPermissionStatus(result.data);
			setPermissionError(null);
			if (result.data.ready) {
				awaitingGrantRef.current = false;
			}
			return result.data;
		},
		[],
	);

	const runPreflight = useCallback(() => {
		if (preflightInFlightRef.current) {
			return preflightInFlightRef.current;
		}
		if (!hasTauriRuntime()) {
			const browserStatus: PermissionPreflightStatus = {
				platform: "other",
				microphone: "not_required",
				accessibility: "not_required",
				ready: true,
			};
			setPermissionStatus(browserStatus);
			setPermissionError(null);
			setPermissionBusy(false);
			return Promise.resolve(browserStatus);
		}
		setPermissionBusy(true);
		const pending = commands
			.permissionRunPreflight()
			.then(acceptPermissionResult)
			.catch((error: unknown) => {
				setPermissionError(
					error instanceof Error ? error.message : String(error),
				);
				return null;
			})
			.finally(() => {
				preflightInFlightRef.current = null;
				setPermissionBusy(false);
			});
		preflightInFlightRef.current = pending;
		return pending;
	}, [acceptPermissionResult]);

	const requestPermission = useCallback(
		async (kind: "microphone" | "accessibility") => {
			setPermissionBusy(true);
			setPermissionError(null);
			awaitingGrantRef.current = true;
			try {
				const result =
					kind === "microphone"
						? await commands.permissionRequestMicrophone()
						: await commands.permissionRequestAccessibility();
				acceptPermissionResult(result);
			} catch (error) {
				setPermissionError(
					error instanceof Error ? error.message : String(error),
				);
			} finally {
				setPermissionBusy(false);
			}
		},
		[acceptPermissionResult],
	);

	useEffect(() => {
		void runPreflight();
	}, [runPreflight]);

	// System privacy panels live outside the webview. Recheck while waiting for a
	// grant and immediately when the user returns, without continuously polling
	// once the preflight is settled.
	useEffect(() => {
		const recheckOnReturn = () => {
			if (document.visibilityState === "visible") {
				void runPreflight();
			}
		};
		const pollWhileWaiting = () => {
			if (awaitingGrantRef.current) {
				recheckOnReturn();
			}
		};
		window.addEventListener("focus", recheckOnReturn);
		document.addEventListener("visibilitychange", recheckOnReturn);
		const poll = window.setInterval(pollWhileWaiting, 1000);
		return () => {
			window.removeEventListener("focus", recheckOnReturn);
			document.removeEventListener("visibilitychange", recheckOnReturn);
			window.clearInterval(poll);
		};
	}, [runPreflight]);

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
							{permissionStatus?.ready && settingsReady ? (
								<OnboardingWizard />
							) : permissionStatus?.ready ? (
								<OnboardingSettingsHydrationState
									error={hydrationError}
									status={hydrationStatus}
								/>
							) : (
								<PermissionPreflightPanel
									busy={permissionBusy}
									error={permissionError}
									onRequestAccessibility={() => {
										void requestPermission("accessibility");
									}}
									onRequestMicrophone={() => {
										void requestPermission("microphone");
									}}
									onRetry={() => {
										void runPreflight();
									}}
									status={permissionStatus}
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

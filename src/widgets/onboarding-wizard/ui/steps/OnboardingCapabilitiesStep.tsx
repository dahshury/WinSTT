import {
	ClipboardPasteIcon,
	EarIcon,
	PictureInPictureOnIcon,
	ToggleOnIcon,
	TouchInteraction01Icon,
	VoiceIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/entities/setting";
import type { RecordingMode } from "@/shared/config/recording-mode-color";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import { OnboardingDictationDemo } from "./OnboardingDictationDemo";

const CARD_SPRING = {
	type: "spring",
	stiffness: 360,
	damping: 32,
	mass: 0.8,
} as const;

/**
 * Overlay & visuals step.
 *
 * Deliberately narrow: this page is only the recording experience the user
 * sees and hears — how a hotkey starts a session (recording mode), and the two
 * visual toggles worth setting before the first dictation (Dynamic Island,
 * preview-before-pasting). Everything else WinSTT can do (post-processing,
 * transforms, read-aloud, history, file transcription, vocabulary) is surfaced
 * separately in the final overview step (`OnboardingOverviewStep`), not buried
 * here — keeping this step focused on the recording experience alone.
 */
export function OnboardingCapabilitiesStep() {
	const tOnboarding = useTranslations("onboarding");
	const tGeneral = useTranslations("general");
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const reduceMotion = useReducedMotion();

	const recordingMode: RecordingMode = general.recordingMode ?? "ptt";
	const dynamicIslandEnabled =
		(general.showRecordingOverlay ?? true) &&
		general.overlayMode === "dynamic-island";
	const reviewEnabled = general.previewBeforePasting ?? false;

	const recordingModeOptions: readonly SwitcherOption<RecordingMode>[] = [
		{
			value: "ptt",
			label: tGeneral("pushToTalk"),
			icon: TouchInteraction01Icon,
		},
		{ value: "toggle", label: tGeneral("toggle"), icon: ToggleOnIcon },
		{ value: "listen", label: tGeneral("listen"), icon: EarIcon },
		{ value: "wakeword", label: tGeneral("wakeWord"), icon: VoiceIcon },
	];
	const updateRecordingMode = (value: RecordingMode): void => {
		const patch = { recordingMode: value };
		updateGeneral(patch);
		void commands
			.winsttSetSettings({ general: { ...general, ...patch } })
			.then((result) => {
				if (result.status === "error") {
					console.error(
						"[onboarding] failed to persist recording mode:",
						result.error,
					);
				}
			})
			.catch((error: unknown) => {
				console.error("[onboarding] failed to persist recording mode:", error);
			});
	};

	const itemInitial = reduceMotion
		? false
		: { opacity: 0, y: 8, filter: "blur(2px)" };
	const itemAnimate = { opacity: 1, y: 0, filter: "blur(0px)" };

	return (
		<LazyMotion features={domAnimation} strict>
			<div className="flex flex-col gap-3">
				<m.div
					animate={itemAnimate}
					initial={itemInitial}
					transition={reduceMotion ? { duration: 0 } : CARD_SPRING}
				>
					<FormControl
						caption={tOnboarding("capabilitiesRecordingModeBody")}
						label={tGeneral("recordingMode")}
						layout="stacked"
					>
						<Switcher
							fullWidth
							onChange={updateRecordingMode}
							options={recordingModeOptions}
							value={recordingMode}
						/>
					</FormControl>
				</m.div>

				<m.div
					animate={itemAnimate}
					initial={itemInitial}
					transition={
						reduceMotion ? { duration: 0 } : { ...CARD_SPRING, delay: 0.03 }
					}
				>
					<OnboardingDictationDemo />
				</m.div>

				{/* Overlay + paste visuals don't apply to Listen mode (it transcribes a
				    loopback device in-app — no recording overlay, no paste), so hide
				    them when Listen is the selected recording mode. */}
				{recordingMode === "listen" ? null : (
					<>
						<m.div
							animate={itemAnimate}
							initial={itemInitial}
							transition={
								reduceMotion ? { duration: 0 } : { ...CARD_SPRING, delay: 0.04 }
							}
						>
							<QuickOption
								checked={dynamicIslandEnabled}
								description={tOnboarding("capabilitiesDynamicIslandBody")}
								icon={PictureInPictureOnIcon}
								onToggle={(next) =>
									updateGeneral(
										next
											? {
													showRecordingOverlay: true,
													overlayMode: "dynamic-island",
													overlayPosition: "auto",
													liveTranscriptionDisplay: "both",
												}
											: { overlayMode: "floating-bottom" },
									)
								}
								title={tGeneral("overlayModeDynamicIsland")}
							/>
						</m.div>

						<m.div
							animate={itemAnimate}
							initial={itemInitial}
							transition={
								reduceMotion ? { duration: 0 } : { ...CARD_SPRING, delay: 0.07 }
							}
						>
							<QuickOption
								checked={reviewEnabled}
								description={tOnboarding("capabilitiesPreviewBody")}
								icon={ClipboardPasteIcon}
								onToggle={(next) =>
									updateGeneral(
										next
											? {
													previewBeforePasting: true,
													wordByWordPasting: false,
													showRecordingOverlay: true,
													overlayPosition: "auto",
													liveTranscriptionDisplay: "both",
												}
											: { previewBeforePasting: false },
									)
								}
								title={tGeneral("previewBeforePasting")}
							/>
						</m.div>
					</>
				)}
			</div>
		</LazyMotion>
	);
}

interface QuickOptionProps {
	checked: boolean;
	description: string;
	icon: IconSvgElement;
	onToggle: (next: boolean) => void;
	title: string;
}

function QuickOption({
	checked,
	description,
	icon,
	title,
	onToggle,
}: QuickOptionProps) {
	return (
		<ElevatedSurface className="overflow-hidden">
			<div
				className={cn(
					"relative flex items-start gap-3 px-4 py-3 transition-colors duration-200",
					checked && "bg-accent/[0.06]",
				)}
			>
				{checked ? (
					<span
						aria-hidden
						className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent"
					/>
				) : null}
				<span
					aria-hidden
					className={cn(
						"mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ring-1",
						checked
							? "bg-accent/15 text-accent ring-accent/30"
							: "bg-surface-2 text-foreground-muted ring-divider",
					)}
				>
					<HugeiconsIcon icon={icon} size={15} />
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-center justify-between gap-3">
						<h2 className="font-semibold text-body text-foreground leading-snug">
							{title}
						</h2>
						<Toggle
							aria-label={title}
							checked={checked}
							onCheckedChange={onToggle}
						/>
					</div>
					<p className="mt-1 text-body-sm text-foreground-muted leading-snug">
						{description}
					</p>
				</div>
			</div>
		</ElevatedSurface>
	);
}

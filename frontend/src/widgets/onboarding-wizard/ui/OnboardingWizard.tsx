import {
	ArrowLeft02Icon,
	ArrowRight02Icon,
	CheckmarkCircle02Icon,
	CloudIcon,
	ComputerIcon,
	Mic01Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcSend } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { ScrollArea } from "@/shared/ui/scroll-area";
import {
	TextureCard,
	TextureCardBody,
	TextureCardHeader,
	TextureSeparator,
} from "@/shared/ui/texture-card";
import {
	isFirstStep,
	isLastStep,
	type OnboardingStepId,
	useOnboardingWizardStore,
	visibleSteps,
} from "../model/wizard-store";
import { StepIndicator } from "./StepIndicator";
import { OnboardingCloudKeysStep } from "./steps/OnboardingCloudKeysStep";
import { OnboardingLlmSetupStep } from "./steps/OnboardingLlmSetupStep";
import { OnboardingLocalVsCloudStep } from "./steps/OnboardingLocalVsCloudStep";
import { OnboardingMicTestStep } from "./steps/OnboardingMicTestStep";

interface StepMeta {
	icon: IconSvgElement;
	short: string;
	subtitle: string;
	title: string;
}

const STEP_TITLES: Record<OnboardingStepId, StepMeta> = {
	welcome: {
		title: "Welcome to WinSTT",
		subtitle:
			"Choose how you'd like to transcribe — fully offline with Whisper on your machine, or via a cloud provider.",
		short: "Start",
		icon: ComputerIcon,
	},
	mic: {
		title: "Test your microphone",
		subtitle: "Pick your input device and confirm we can hear you.",
		short: "Mic",
		icon: Mic01Icon,
	},
	"cloud-keys": {
		title: "Connect a cloud provider",
		subtitle: "Paste your API key. You can always change this later in Settings.",
		short: "Keys",
		icon: CloudIcon,
	},
	llm: {
		title: "Smarter dictation",
		subtitle:
			"Optional — let a local LLM clean up filler words, fix punctuation, and follow custom prompts on the way to the cursor.",
		short: "LLM",
		icon: SparklesIcon,
	},
};

/**
 * First-run wizard, composed entirely from system primitives so it visually
 * belongs in the same window family as Settings:
 *
 *   - Heading strip sits at the top of the viewport with the step's icon
 *     badge (accent/12 + accent/30 ring, mirroring SettingSection headers),
 *     the section title (`text-title`), the subtitle (`text-body-sm muted`),
 *     and the StepIndicator on the trailing edge.
 *   - The current step renders inside a `TextureCard` (offset=1 → surface-3
 *     on the surface-2 viewport substrate), matching every settings panel.
 *   - Footer mirrors Settings' button conventions: ghost back, link skip,
 *     accent primary next/finish with the brand bottom-edge glow.
 */
export function OnboardingWizard() {
	const currentStep = useOnboardingWizardStore((s) => s.currentStep);
	const track = useOnboardingWizardStore((s) => s.track);
	const micTestPassed = useOnboardingWizardStore((s) => s.micTestPassed);
	const goNext = useOnboardingWizardStore((s) => s.goNext);
	const goBack = useOnboardingWizardStore((s) => s.goBack);

	const steps = visibleSteps(track).map((id) => ({ id, label: STEP_TITLES[id].short }));
	const last = isLastStep(currentStep, track);
	const first = isFirstStep(currentStep, track);
	const meta = STEP_TITLES[currentStep];

	// "Next" is gated only on hard prerequisites; everything else is skippable.
	//  - welcome: must pick a track
	//  - mic: must pass the level test OR explicitly skip via the step's own link
	//  - cloud-keys / llm: always advanceable (skip via Next on the last step)
	const nextEnabled =
		(currentStep === "welcome" && track !== "") ||
		(currentStep === "mic" && micTestPassed) ||
		currentStep === "cloud-keys" ||
		currentStep === "llm";

	const handleFinish = (completed: boolean) => {
		ipcSend(IPC.ONBOARDING_FINISH, { completed, track });
	};

	const handleNext = () => {
		if (last) {
			handleFinish(true);
			return;
		}
		goNext();
	};

	return (
		<div className="flex h-full flex-col">
			{/* Heading strip — matches SettingSection's header row: icon badge,
			    title, subtitle. Step indicator floats on the trailing edge. */}
			<header className="flex shrink-0 items-start gap-4 px-6 pt-5 pb-4">
				<span
					aria-hidden
					className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent ring-1 ring-accent/30"
				>
					<HugeiconsIcon icon={meta.icon} size={17} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<h1 className="font-semibold text-foreground text-title leading-tight">{meta.title}</h1>
					<p className="text-body-sm text-foreground-muted leading-snug">{meta.subtitle}</p>
				</div>
				<div className="mt-1 hidden sm:block">
					<StepIndicator current={currentStep} steps={steps} />
				</div>
			</header>

			{/* Scrollable step body — wrapped in a TextureCard so every step
			    gets the same etched-groove framing the settings panels use. */}
			<ScrollArea className="flex-1" viewportClassName="px-6 pb-5">
				<TextureCard offset={1}>
					<TextureCardHeader className="py-3">
						<span className="font-medium font-mono text-foreground-secondary text-xs-tight uppercase tracking-[0.18em]">
							{stepLabelFor(currentStep)}
						</span>
					</TextureCardHeader>
					<TextureSeparator />
					<TextureCardBody className="px-5 py-4">
						<StepBody step={currentStep} />
					</TextureCardBody>
				</TextureCard>
			</ScrollArea>

			{/* Footer — surface-2 strip with a top hairline, mirroring Settings'
			    visual conventions. Buttons use the canonical app styles:
			    ghost back, link-style skip, accent primary CTA. */}
			<footer className="flex shrink-0 items-center justify-between gap-3 border-divider border-t bg-gradient-to-t from-[var(--color-surface-3)]/40 to-transparent px-6 py-3">
				<WizardGhostButton disabled={first} onClick={goBack}>
					<HugeiconsIcon icon={ArrowLeft02Icon} size={13} />
					<span>Back</span>
				</WizardGhostButton>
				<div className="flex items-center gap-3">
					<button
						className="font-mono text-foreground-muted text-xs-tight uppercase tracking-[0.16em] underline-offset-4 transition-colors hover:text-foreground-secondary hover:underline"
						onClick={() => handleFinish(false)}
						type="button"
					>
						Skip setup
					</button>
					<WizardPrimaryButton disabled={!nextEnabled} onClick={handleNext}>
						<span>{last ? "Finish" : "Next"}</span>
						<HugeiconsIcon icon={last ? CheckmarkCircle02Icon : ArrowRight02Icon} size={13} />
					</WizardPrimaryButton>
				</div>
			</footer>
		</div>
	);
}

function stepLabelFor(step: OnboardingStepId): string {
	if (step === "welcome") {
		return "01 · Choose your track";
	}
	if (step === "mic") {
		return "02 · Microphone";
	}
	if (step === "cloud-keys") {
		return "03 · API keys";
	}
	return "04 · LLM cleanup";
}

function StepBody({ step }: { step: OnboardingStepId }) {
	if (step === "welcome") {
		return <OnboardingLocalVsCloudStep />;
	}
	if (step === "mic") {
		return <OnboardingMicTestStep />;
	}
	if (step === "cloud-keys") {
		return <OnboardingCloudKeysStep />;
	}
	return <OnboardingLlmSetupStep />;
}

interface ButtonProps {
	children: React.ReactNode;
	disabled?: boolean;
	onClick: () => void;
}

/**
 * Primary CTA. Uses the brand `shadow-elevated` recipe (accent bottom-edge
 * glow + multi-layer drop) so the button reads as the same family as the
 * `ElevatedSurface` controls in Settings.
 */
function WizardPrimaryButton({ disabled, onClick, children }: ButtonProps) {
	return (
		<button
			className={cn(
				"inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent px-4 font-medium text-body text-white outline-none transition-[background-color,box-shadow] duration-150",
				"shadow-elevated hover:bg-accent-hover",
				"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
				"disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
			)}
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}

/** Ghost back button — flat until hover, mirroring IconButton conventions. */
function WizardGhostButton({ disabled, onClick, children }: ButtonProps) {
	return (
		<button
			className={cn(
				"inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-transparent px-3 font-medium text-body text-foreground-muted outline-none transition-[background-color,color] duration-150",
				"hover:bg-foreground/[0.06] hover:text-foreground-secondary",
				"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
				"disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-foreground-muted"
			)}
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}

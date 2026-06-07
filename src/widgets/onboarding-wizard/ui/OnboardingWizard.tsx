import { Button as BaseButton } from "@base-ui/react/button";
import {
	ArrowLeft02Icon,
	ArrowRight02Icon,
	CheckmarkCircle02Icon,
	CloudIcon,
	ComputerIcon,
	GridIcon,
	Mic01Icon,
	ServerStack01Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m,
	useReducedMotion,
	type Variants,
} from "motion/react";
import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
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
	type OnboardingTrack,
	type OnboardingStepId,
	useOnboardingWizardStore,
	visibleSteps,
} from "../model/wizard-store";
import { StepIndicator } from "./StepIndicator";
import { OnboardingCapabilitiesStep } from "./steps/OnboardingCapabilitiesStep";
import { OnboardingCloudKeysStep } from "./steps/OnboardingCloudKeysStep";
import { OnboardingLlmSetupStep } from "./steps/OnboardingLlmSetupStep";
import { OnboardingLocalVsCloudStep } from "./steps/OnboardingLocalVsCloudStep";
import { OnboardingMicTestStep } from "./steps/OnboardingMicTestStep";
import { OnboardingSttModelStep } from "./steps/OnboardingSttModelStep";

type OnboardingT = ReturnType<typeof useTranslations<"onboarding">>;

interface StepMeta {
	icon: IconSvgElement;
	short: string;
	subtitle: string;
	title: string;
}

const STEP_ICONS: Record<OnboardingStepId, IconSvgElement> = {
	welcome: ComputerIcon,
	"stt-model": ServerStack01Icon,
	capabilities: GridIcon,
	mic: Mic01Icon,
	"cloud-keys": CloudIcon,
	llm: SparklesIcon,
};

const STEP_SPRING = {
	type: "spring",
	stiffness: 460,
	damping: 38,
	mass: 0.8,
} as const;

const STEP_BODY_VARIANTS = {
	initial: ({
		direction,
		reduceMotion,
	}: {
		direction: number;
		reduceMotion: boolean;
	}) => ({
		opacity: reduceMotion ? 1 : 0,
		x: reduceMotion ? 0 : direction > 0 ? 16 : -16,
		filter: reduceMotion ? "blur(0px)" : "blur(4px)",
	}),
	animate: ({
		reduceMotion,
	}: {
		direction: number;
		reduceMotion: boolean;
	}) => ({
		opacity: 1,
		x: 0,
		filter: "blur(0px)",
		transition: reduceMotion ? { duration: 0 } : STEP_SPRING,
	}),
	exit: ({
		direction,
		reduceMotion,
	}: {
		direction: number;
		reduceMotion: boolean;
	}) => ({
		opacity: reduceMotion ? 1 : 0,
		x: reduceMotion ? 0 : direction > 0 ? -12 : 12,
		filter: reduceMotion ? "blur(0px)" : "blur(3px)",
		transition: { duration: reduceMotion ? 0 : 0.14, ease: [0.22, 1, 0.36, 1] },
	}),
} satisfies Variants;

const STEP_HEADER_VARIANTS = {
	initial: ({
		direction,
		reduceMotion,
	}: {
		direction: number;
		reduceMotion: boolean;
	}) => ({
		opacity: reduceMotion ? 1 : 0,
		y: reduceMotion ? 0 : 4,
		x: reduceMotion ? 0 : direction > 0 ? 6 : -6,
		filter: reduceMotion ? "blur(0px)" : "blur(2px)",
	}),
	animate: ({
		reduceMotion,
	}: {
		direction: number;
		reduceMotion: boolean;
	}) => ({
		opacity: 1,
		y: 0,
		x: 0,
		filter: "blur(0px)",
		transition: reduceMotion
			? { duration: 0 }
			: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
	}),
	exit: ({
		direction,
		reduceMotion,
	}: {
		direction: number;
		reduceMotion: boolean;
	}) => ({
		opacity: reduceMotion ? 1 : 0,
		y: reduceMotion ? 0 : -3,
		x: reduceMotion ? 0 : direction > 0 ? -5 : 5,
		filter: reduceMotion ? "blur(0px)" : "blur(2px)",
		transition: { duration: reduceMotion ? 0 : 0.12, ease: "easeInOut" },
	}),
} satisfies Variants;

const BUTTON_MOTION_PROPS = {
	whileHover: { y: -1 },
	whileTap: { scale: 0.97 },
} as const;
const MotionBaseButton = m.create(BaseButton);

function stepMeta(step: OnboardingStepId, t: OnboardingT): StepMeta {
	const byStep: Record<OnboardingStepId, Omit<StepMeta, "icon">> = {
		welcome: {
			title: t("stepWelcomeTitle"),
			subtitle: t("stepWelcomeSubtitle"),
			short: t("stepWelcomeShort"),
		},
		capabilities: {
			title: t("stepCapabilitiesTitle"),
			subtitle: t("stepCapabilitiesSubtitle"),
			short: t("stepCapabilitiesShort"),
		},
		"stt-model": {
			title: "Choose a local speech model",
			subtitle:
				"Download one model before finishing setup. WinSTT does not ship with STT weights.",
			short: "Model",
		},
		mic: {
			title: t("stepMicTitle"),
			subtitle: t("stepMicSubtitle"),
			short: t("stepMicShort"),
		},
		"cloud-keys": {
			title: t("stepKeysTitle"),
			subtitle: t("stepKeysSubtitle"),
			short: t("stepKeysShort"),
		},
		llm: {
			title: t("stepLlmTitle"),
			subtitle: t("stepLlmSubtitle"),
			short: t("stepLlmShort"),
		},
	};
	return { ...byStep[step], icon: STEP_ICONS[step] };
}

function useStepDirection(
	currentStep: OnboardingStepId,
	track: OnboardingTrack,
): number {
	const order = visibleSteps(track);
	const currentIndex = Math.max(order.indexOf(currentStep), 0);
	const previousRef = useRef({ index: currentIndex, track });
	const previous = previousRef.current;
	const direction =
		previous.track === track && previous.index !== currentIndex
			? Math.sign(currentIndex - previous.index)
			: 1;

	useEffect(() => {
		previousRef.current = { index: currentIndex, track };
	}, [currentIndex, track]);

	return direction || 1;
}

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
	const t = useTranslations("onboarding");
	const currentStep = useOnboardingWizardStore((s) => s.currentStep);
	const track = useOnboardingWizardStore((s) => s.track);
	const micTestPassed = useOnboardingWizardStore((s) => s.micTestPassed);
	const sttModelReady = useOnboardingWizardStore((s) => s.sttModelReady);
	const cloudSttReady = useOnboardingWizardStore((s) => s.cloudSttReady);
	const goNext = useOnboardingWizardStore((s) => s.goNext);
	const goBack = useOnboardingWizardStore((s) => s.goBack);
	const reduceMotion = useReducedMotion();

	const steps = visibleSteps(track).map((id) => ({
		id,
		label: stepMeta(id, t).short,
	}));
	const last = isLastStep(currentStep, track);
	const first = isFirstStep(currentStep, track);
	const meta = stepMeta(currentStep, t);
	const direction = useStepDirection(currentStep, track);
	const motionContext = { direction, reduceMotion: Boolean(reduceMotion) };

	// "Next" is gated only on hard prerequisites; everything else is skippable.
	//  - welcome: must pick a track
	//  - stt-model: local track must have a selected model cached on disk
	//  - cloud-keys: cloud track must have a provider key and selected model
	//  - capabilities: awareness + optional quick toggles, always skippable
	//  - mic: must pass the level test OR explicitly skip via the step's own link
	//  - llm: always advanceable
	const nextEnabled =
		(currentStep === "welcome" && track !== "") ||
		(currentStep === "stt-model" && sttModelReady) ||
		currentStep === "capabilities" ||
		(currentStep === "mic" && micTestPassed) ||
		(currentStep === "cloud-keys" && cloudSttReady) ||
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
		<LazyMotion features={domAnimation} strict>
			<div className="flex h-full flex-col">
				{/* Heading strip — matches SettingSection's header row: icon badge,
			    title, subtitle. Step indicator floats on the trailing edge. */}
				<header className="flex shrink-0 items-start gap-4 px-6 pt-5 pb-4">
					<span
						aria-hidden
						className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent ring-1 ring-accent/30"
					>
						<AnimatePresence custom={motionContext} initial={false} mode="wait">
							<m.span
								animate="animate"
								className="inline-flex"
								custom={motionContext}
								exit="exit"
								initial="initial"
								key={currentStep}
								variants={STEP_HEADER_VARIANTS}
							>
								<HugeiconsIcon icon={meta.icon} size={17} />
							</m.span>
						</AnimatePresence>
					</span>
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<AnimatePresence custom={motionContext} initial={false} mode="wait">
							<m.div
								animate="animate"
								custom={motionContext}
								exit="exit"
								initial="initial"
								key={currentStep}
								variants={STEP_HEADER_VARIANTS}
							>
								<h1 className="font-semibold text-foreground text-title leading-tight">
									{meta.title}
								</h1>
								<p className="text-body-sm text-foreground-muted leading-snug">
									{meta.subtitle}
								</p>
							</m.div>
						</AnimatePresence>
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
							<AnimatePresence
								custom={motionContext}
								initial={false}
								mode="wait"
							>
								<m.span
									animate="animate"
									className="inline-block font-medium font-mono text-foreground-secondary text-xs-tight uppercase tracking-[0.18em]"
									custom={motionContext}
									exit="exit"
									initial="initial"
									key={currentStep}
									variants={STEP_HEADER_VARIANTS}
								>
									{stepLabelFor(currentStep, t)}
								</m.span>
							</AnimatePresence>
						</TextureCardHeader>
						<TextureSeparator />
						<TextureCardBody className="overflow-hidden px-5 py-4">
							<AnimatePresence
								custom={motionContext}
								initial={false}
								mode="wait"
							>
								<m.div
									animate="animate"
									custom={motionContext}
									exit="exit"
									initial="initial"
									key={currentStep}
									variants={STEP_BODY_VARIANTS}
								>
									<StepBody step={currentStep} />
								</m.div>
							</AnimatePresence>
						</TextureCardBody>
					</TextureCard>
				</ScrollArea>

				{/* Footer — surface-2 strip with a top hairline, mirroring Settings'
			    visual conventions. Buttons use the canonical app styles:
			    ghost back, link-style skip, accent primary CTA. */}
				<footer className="flex shrink-0 items-center justify-between gap-3 border-divider border-t bg-gradient-to-t from-[var(--color-surface-3)]/40 to-transparent px-6 py-3">
					<WizardGhostButton disabled={first} onClick={goBack}>
						<HugeiconsIcon icon={ArrowLeft02Icon} size={13} />
						<span>{t("back")}</span>
					</WizardGhostButton>
					<div className="flex items-center gap-3">
						<WizardPrimaryButton disabled={!nextEnabled} onClick={handleNext}>
							<span>{last ? t("finish") : t("next")}</span>
							<HugeiconsIcon
								icon={last ? CheckmarkCircle02Icon : ArrowRight02Icon}
								size={13}
							/>
						</WizardPrimaryButton>
					</div>
				</footer>
			</div>
		</LazyMotion>
	);
}

function stepLabelFor(step: OnboardingStepId, t: OnboardingT): string {
	if (step === "welcome") {
		return t("stepLabelWelcome");
	}
	if (step === "stt-model") {
		return "02 - Speech model";
	}
	if (step === "capabilities") {
		return t("stepLabelCapabilities");
	}
	if (step === "mic") {
		return t("stepLabelMic");
	}
	if (step === "cloud-keys") {
		return t("stepLabelKeys");
	}
	return t("stepLabelLlm");
}

function StepBody({ step }: { step: OnboardingStepId }) {
	if (step === "welcome") {
		return <OnboardingLocalVsCloudStep />;
	}
	if (step === "stt-model") {
		return <OnboardingSttModelStep />;
	}
	if (step === "capabilities") {
		return <OnboardingCapabilitiesStep />;
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
		<MotionBaseButton
			className={cn(
				"inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent px-4 font-medium text-body text-white outline-none transition-[background-color,box-shadow] duration-150",
				"shadow-elevated hover:bg-accent-hover",
				"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
				"disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none",
			)}
			disabled={disabled}
			onClick={onClick}
			whileHover={BUTTON_MOTION_PROPS.whileHover}
			whileTap={BUTTON_MOTION_PROPS.whileTap}
			type="button"
		>
			{children}
		</MotionBaseButton>
	);
}

/** Ghost back button — flat until hover, mirroring IconButton conventions. */
function WizardGhostButton({ disabled, onClick, children }: ButtonProps) {
	return (
		<MotionBaseButton
			className={cn(
				"inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-transparent px-3 font-medium text-body text-foreground-muted outline-none transition-[background-color,color] duration-150",
				"hover:bg-foreground/[0.06] hover:text-foreground-secondary",
				"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
				"disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-foreground-muted",
			)}
			disabled={disabled}
			onClick={onClick}
			whileHover={BUTTON_MOTION_PROPS.whileHover}
			whileTap={BUTTON_MOTION_PROPS.whileTap}
			type="button"
		>
			{children}
		</MotionBaseButton>
	);
}

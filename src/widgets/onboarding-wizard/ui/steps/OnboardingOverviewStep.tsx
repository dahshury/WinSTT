import { Button as BaseButton } from "@base-ui/react/button";
import {
	AiVoiceGeneratorIcon,
	ArrowUpRight01Icon,
	CalendarAnalysisIcon,
	FileScriptIcon,
	MagicWand01Icon,
	SparklesIcon,
	TextSquareIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";

const CARD_SPRING = {
	type: "spring",
	stiffness: 360,
	damping: 32,
	mass: 0.8,
} as const;
const MotionBaseButton = m.create(BaseButton);

interface Ability {
	description: string;
	icon: IconSvgElement;
	/** `Tabs.Panel value` in SettingsPage this ability is configured under. */
	section: string;
	title: string;
}

interface OnboardingOverviewStepProps {
	onOpenSettingsSection: (section: string) => void | Promise<void>;
}

/**
 * Final onboarding step — a standalone "what else WinSTT can do" overview, lifted
 * out of the Overlay & visuals step so the capability tour isn't buried inside an
 * unrelated settings page. It's pure orientation: every item ships a sensible
 * default and a home in Settings, so nothing here needs configuring to finish.
 *
 * Each card is a deep-link: clicking it completes onboarding, closes the wizard,
 * and opens Settings on that capability's section, so a user who wants to tweak
 * something can do it right now without hunting for the tab afterwards.
 */
export function OnboardingOverviewStep({
	onOpenSettingsSection,
}: OnboardingOverviewStepProps) {
	const tLlm = useTranslations("llm");
	const tTts = useTranslations("tts");
	const tHistory = useTranslations("history");
	const tGeneral = useTranslations("general");
	const tSettings = useTranslations("settings");
	const reduceMotion = useReducedMotion();

	const abilities: readonly Ability[] = [
		{
			icon: SparklesIcon,
			title: tLlm("title"),
			description: tSettings("tabProcessingTooltip"),
			section: "processing",
		},
		{
			icon: MagicWand01Icon,
			title: tLlm("subTransformTitle"),
			description: tLlm("subTransformCaption"),
			section: "processing",
		},
		{
			icon: AiVoiceGeneratorIcon,
			title: tTts("title"),
			description: tSettings("tabReadAloudTooltip"),
			section: "readAloud",
		},
		{
			icon: TextSquareIcon,
			title: tSettings("tabVocabulary"),
			description: tSettings("tabVocabularyTooltip"),
			section: "vocabulary",
		},
		{
			icon: FileScriptIcon,
			title: tGeneral("fileTranscription"),
			description: tSettings("tabDeliveryTooltip"),
			section: "output",
		},
		{
			icon: CalendarAnalysisIcon,
			title: tHistory("pageTitle"),
			description: tSettings("tabHistoryTooltip"),
			section: "history",
		},
	];

	const itemInitial = reduceMotion
		? false
		: { opacity: 0, y: 8, filter: "blur(2px)" };
	const itemAnimate = { opacity: 1, y: 0, filter: "blur(0px)" };

	return (
		<LazyMotion features={domAnimation} strict>
			<div className="flex flex-col gap-3">
				<ul className="grid gap-2 sm:grid-cols-2">
					{abilities.map((ability, index) => (
						<m.li
							animate={itemAnimate}
							initial={itemInitial}
							key={ability.title}
							transition={
								reduceMotion
									? { duration: 0 }
									: { ...CARD_SPRING, delay: 0.03 * index }
							}
						>
							<AbilityLink
								ability={ability}
								onOpenSettingsSection={onOpenSettingsSection}
							/>
						</m.li>
					))}
				</ul>
			</div>
		</LazyMotion>
	);
}

function AbilityLink({
	ability,
	onOpenSettingsSection,
}: {
	ability: Ability;
	onOpenSettingsSection: (section: string) => void | Promise<void>;
}) {
	return (
		<MotionBaseButton
			aria-label={`Configure ${ability.title} in Settings`}
			className={cn(
				"group flex h-full w-full items-start gap-2.5 rounded-md bg-surface-4 px-3 py-2.5 text-left outline-none ring-1 ring-divider-strong transition-[background-color,box-shadow] duration-150",
				"hover:bg-surface-5 hover:ring-border-hover",
				"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
			)}
			onClick={() => void onOpenSettingsSection(ability.section)}
			transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.65 }}
			type="button"
			whileHover={{ y: -1 }}
			whileTap={{ scale: 0.985 }}
		>
			<span
				aria-hidden
				className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-foreground-muted ring-1 ring-divider transition-colors duration-150 group-hover:bg-accent/15 group-hover:text-accent group-hover:ring-accent/30"
			>
				<HugeiconsIcon icon={ability.icon} size={14} />
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-1">
					<span className="truncate font-semibold text-body text-foreground">
						{ability.title}
					</span>
					<HugeiconsIcon
						aria-hidden
						className="shrink-0 text-foreground-dim transition-colors duration-150 group-hover:text-accent"
						icon={ArrowUpRight01Icon}
						size={13}
					/>
				</span>
				<span className="mt-0.5 line-clamp-2 block text-body-sm text-foreground-muted leading-snug">
					{ability.description}
				</span>
			</span>
		</MotionBaseButton>
	);
}

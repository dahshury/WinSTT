import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import {
	CheckmarkCircle02Icon,
	CloudIcon,
	ComputerIcon,
	InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, LayoutGroup, m } from "motion/react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import {
	type OnboardingTrack,
	useOnboardingWizardStore,
} from "../../model/wizard-store";

interface TrackOption {
	bullets: readonly string[];
	icon: IconSvgElement;
	id: Exclude<OnboardingTrack, "">;
	subtitle: string;
	title: string;
}

const TRACKS: readonly TrackOption[] = [
	{
		id: "local",
		icon: ComputerIcon,
		title: "Use my computer",
		subtitle: "Offline transcription with Whisper. Recommended.",
		bullets: [
			"No API keys, no usage caps, fully private",
			"Runs on CPU or NVIDIA GPU automatically",
			"Choose and download one speech model during setup",
		],
	},
	{
		id: "cloud",
		icon: CloudIcon,
		title: "Use a cloud provider",
		subtitle: "Best-in-class accuracy via OpenRouter or ElevenLabs.",
		bullets: [
			"Highest accuracy, lowest latency",
			"Requires an OpenRouter or ElevenLabs API key",
			"Audio is uploaded to the chosen provider",
		],
	},
];
const MotionRadioRoot = m.create(Radio.Root);

/**
 * Step 1: pick the STT track for the user's first dictation. Renders as a
 * pair of selectable cards styled to match Settings' tile-style choices
 * (accent ring + accent/12 fill when selected, divider-strong ring +
 * surface-4 fill when not).
 */
export function OnboardingLocalVsCloudStep() {
	const track = useOnboardingWizardStore((s) => s.track);
	const setTrack = useOnboardingWizardStore((s) => s.setTrack);

	return (
		<LayoutGroup id="onboarding-track-choice">
			<RadioGroup
				aria-label="Choose how WinSTT transcribes your voice"
				className="grid gap-4 sm:grid-cols-2"
				onValueChange={(value) =>
					setTrack(value as Exclude<OnboardingTrack, "">)
				}
				value={track}
			>
				{TRACKS.map((option) => {
					const selected = track === option.id;
					return (
						<TrackCard key={option.id} option={option} selected={selected} />
					);
				})}
			</RadioGroup>
			<TrackChoiceNote />
		</LayoutGroup>
	);
}

/**
 * Footnote clarifying the scope of this choice. Two things users routinely
 * assume wrongly here: (1) that the pick is permanent, and (2) that it locks
 * every feature to local/cloud. Neither is true — this only seeds the
 * speech-to-text engine for the first dictation; the track is changeable later
 * in Settings, and text-to-speech and post-processing each pick local or cloud
 * independently.
 */
function TrackChoiceNote() {
	const t = useTranslations("onboarding");

	return (
		<m.div
			animate={{ opacity: 1, y: 0 }}
			className="mt-3 flex items-start gap-2.5 rounded-md bg-surface-2 px-3 py-2.5 ring-1 ring-divider"
			initial={{ opacity: 0, y: 4 }}
			transition={{ duration: 0.22, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
		>
			<span
				aria-hidden
				className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm bg-surface-3 text-foreground-muted ring-1 ring-divider"
			>
				<HugeiconsIcon icon={InformationCircleIcon} size={12} />
			</span>
			<p className="text-body text-foreground-muted leading-normal">
				{t.rich("trackChoiceNote", {
					strong: (chunks) => (
						<span className="font-medium text-foreground-secondary">
							{chunks}
						</span>
					),
				})}
			</p>
		</m.div>
	);
}

interface TrackCardProps {
	option: TrackOption;
	selected: boolean;
}

function TrackCard({ option, selected }: TrackCardProps) {
	return (
		<MotionRadioRoot
			aria-label={option.title}
			className={cn(
				"group relative flex cursor-pointer flex-col items-start gap-3 overflow-hidden rounded-xl px-5 py-5 text-left outline-none transition-[background-color,box-shadow] duration-200 ease-out",
				"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
				selected
					? "bg-accent/[0.08] shadow-elevated"
					: "bg-surface-4 shadow-surface-3 ring-1 ring-divider-strong hover:bg-surface-5 hover:ring-border-hover",
			)}
			layout
			transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.65 }}
			whileHover={{ y: -2 }}
			whileTap={{ scale: 0.985 }}
			value={option.id}
		>
			{selected ? (
				<m.span
					aria-hidden
					className="pointer-events-none absolute inset-0 rounded-xl bg-accent/[0.07] ring-1 ring-accent"
					layoutId="onboarding-track-selected-surface"
					transition={{
						type: "spring",
						stiffness: 520,
						damping: 38,
						mass: 0.65,
					}}
				/>
			) : null}
			{/* Top hairline — only visible when selected, matches the titlebar's
			    Docker-blue accent line and SettingsSidebar's accent treatment. */}
			{selected ? (
				<m.span
					aria-hidden
					className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent"
					animate={{ opacity: 1, scaleX: 1 }}
					initial={{ opacity: 0, scaleX: 0.4 }}
					transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
				/>
			) : null}

			<div className="relative z-raised flex w-full items-center gap-3">
				<span
					aria-hidden
					className={cn(
						"flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors duration-150",
						selected
							? "bg-accent/15 text-accent ring-1 ring-accent/30"
							: "bg-surface-2 text-foreground-muted ring-1 ring-divider",
					)}
				>
					<HugeiconsIcon icon={option.icon} size={22} />
				</span>
				<span className="flex-1 font-semibold text-base text-foreground">
					{option.title}
				</span>
				<AnimatePresence initial={false}>
					{selected ? (
						<m.span
							animate={{ opacity: 1, rotate: 0, scale: 1 }}
							className="inline-flex text-accent"
							exit={{ opacity: 0, rotate: -20, scale: 0.4 }}
							initial={{ opacity: 0, rotate: -35, scale: 0.35 }}
							transition={{ type: "spring", stiffness: 620, damping: 28 }}
						>
							<HugeiconsIcon
								aria-hidden
								icon={CheckmarkCircle02Icon}
								size={18}
							/>
						</m.span>
					) : null}
				</AnimatePresence>
			</div>

			<p className="relative z-raised text-body text-foreground-secondary leading-normal">
				{option.subtitle}
			</p>

			<m.ul
				animate="visible"
				className="relative z-raised mt-1.5 flex flex-col gap-2"
				initial="hidden"
				variants={{
					hidden: {},
					visible: { transition: { staggerChildren: 0.035 } },
				}}
			>
				{option.bullets.map((bullet) => (
					<m.li
						className="flex items-start gap-2.5 text-body text-foreground-secondary leading-normal"
						key={bullet}
						variants={{
							hidden: { opacity: 0, y: 4, filter: "blur(2px)" },
							visible: {
								opacity: 1,
								y: 0,
								filter: "blur(0px)",
								transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
							},
						}}
					>
						<span
							aria-hidden
							className="mt-[7px] size-1.5 shrink-0 rounded-full bg-foreground-muted"
						/>
						<span>{bullet}</span>
					</m.li>
				))}
			</m.ul>
		</MotionRadioRoot>
	);
}

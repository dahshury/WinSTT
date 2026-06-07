import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import {
	CheckmarkCircle02Icon,
	CloudIcon,
	ComputerIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, LayoutGroup, m } from "motion/react";
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
		subtitle: "Best-in-class accuracy via OpenAI or ElevenLabs.",
		bullets: [
			"Highest accuracy, lowest latency",
			"Requires an OpenAI or ElevenLabs API key",
			"Audio is uploaded to the chosen provider",
		],
	},
];
const MotionRadioRoot = m.create(Radio.Root);

/**
 * Step 1: pick the STT track for the user's first dictation. Renders as a
 * pair of selectable cards styled to match Settings' tile-style choices
 * (accent ring + accent/12 fill when selected, divider-strong ring +
 * surface-3 fill when not).
 */
export function OnboardingLocalVsCloudStep() {
	const track = useOnboardingWizardStore((s) => s.track);
	const setTrack = useOnboardingWizardStore((s) => s.setTrack);

	return (
		<LayoutGroup id="onboarding-track-choice">
			<RadioGroup
				aria-label="Choose how WinSTT transcribes your voice"
				className="grid gap-3 sm:grid-cols-2"
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
		</LayoutGroup>
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
				"group relative flex cursor-pointer flex-col items-start gap-2 overflow-hidden rounded-lg px-4 py-3.5 text-left outline-none transition-[background-color,box-shadow] duration-200 ease-out",
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
					className="pointer-events-none absolute inset-0 rounded-lg bg-accent/[0.07] ring-1 ring-accent"
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

			<div className="relative z-raised flex w-full items-center gap-2.5">
				<span
					aria-hidden
					className={cn(
						"flex size-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150",
						selected
							? "bg-accent/15 text-accent ring-1 ring-accent/30"
							: "bg-surface-2 text-foreground-muted ring-1 ring-divider",
					)}
				>
					<HugeiconsIcon icon={option.icon} size={16} />
				</span>
				<span className="flex-1 font-semibold text-body text-foreground">
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
								size={14}
							/>
						</m.span>
					) : null}
				</AnimatePresence>
			</div>

			<p className="relative z-raised text-body-sm text-foreground-muted leading-snug">
				{option.subtitle}
			</p>

			<m.ul
				animate="visible"
				className="relative z-raised mt-1 flex flex-col gap-1"
				initial="hidden"
				variants={{
					hidden: {},
					visible: { transition: { staggerChildren: 0.035 } },
				}}
			>
				{option.bullets.map((bullet) => (
					<m.li
						className="flex items-start gap-1.5 text-body-sm text-foreground-dim leading-snug"
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
							className="mt-1.5 size-1 shrink-0 rounded-full bg-foreground-dim"
						/>
						<span>{bullet}</span>
					</m.li>
				))}
			</m.ul>
		</MotionRadioRoot>
	);
}

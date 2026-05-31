import { CheckmarkCircle02Icon, CloudIcon, ComputerIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { type OnboardingTrack, useOnboardingWizardStore } from "../../model/wizard-store";

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
			"Tiny base model (~75 MB) downloads on first run",
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
		<div
			aria-label="Choose how WinSTT transcribes your voice"
			className="grid gap-3 sm:grid-cols-2"
			role="radiogroup"
		>
			{TRACKS.map((option) => {
				const selected = track === option.id;
				return (
					<TrackCard
						key={option.id}
						onSelect={() => setTrack(option.id)}
						option={option}
						selected={selected}
					/>
				);
			})}
		</div>
	);
}

interface TrackCardProps {
	onSelect: () => void;
	option: TrackOption;
	selected: boolean;
}

function TrackCard({ option, selected, onSelect }: TrackCardProps) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: card surface holds rich multi-line content; ARIA radio role is the standard fallback when <input type="radio"> would lose the layout
		<button
			aria-checked={selected}
			aria-label={option.title}
			className={cn(
				"group relative flex flex-col items-start gap-2 overflow-hidden rounded-lg px-4 py-3.5 text-left outline-none transition-[background-color,box-shadow] duration-200 ease-out",
				"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
				selected
					? "bg-accent/[0.08] shadow-elevated ring-1 ring-accent"
					: "bg-surface-4 shadow-surface-3 ring-1 ring-divider-strong hover:bg-surface-5 hover:ring-border-hover"
			)}
			onClick={onSelect}
			role="radio"
			type="button"
		>
			{/* Top hairline — only visible when selected, matches the titlebar's
			    Docker-blue accent line and SettingsSidebar's accent treatment. */}
			{selected ? (
				<span
					aria-hidden
					className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent"
				/>
			) : null}

			<div className="flex w-full items-center gap-2.5">
				<span
					aria-hidden
					className={cn(
						"flex size-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150",
						selected
							? "bg-accent/15 text-accent ring-1 ring-accent/30"
							: "bg-surface-2 text-foreground-muted ring-1 ring-divider"
					)}
				>
					<HugeiconsIcon icon={option.icon} size={16} />
				</span>
				<span className="flex-1 font-semibold text-body text-foreground">{option.title}</span>
				{selected ? (
					<HugeiconsIcon
						aria-hidden
						className="text-accent"
						icon={CheckmarkCircle02Icon}
						size={14}
					/>
				) : null}
			</div>

			<p className="text-body-sm text-foreground-muted leading-snug">{option.subtitle}</p>

			<ul className="mt-1 flex flex-col gap-1">
				{option.bullets.map((bullet) => (
					<li
						className="flex items-start gap-1.5 text-body-sm text-foreground-dim leading-snug"
						key={bullet}
					>
						<span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-foreground-dim" />
						<span>{bullet}</span>
					</li>
				))}
			</ul>
		</button>
	);
}

import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, m } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import type { OnboardingStepId } from "../model/wizard-store";

type StepStatus = "complete" | "current" | "upcoming";

interface StepIndicatorProps {
	readonly current: OnboardingStepId;
	/** Navigate to an already-visited step. Wired to the store's `goToStep`,
	 *  which only ever moves backwards — so this is a no-op for upcoming steps. */
	readonly onSelect?: (id: OnboardingStepId) => void;
	readonly steps: readonly { id: OnboardingStepId; label: string }[];
}

function statusFor(index: number, currentIdx: number): StepStatus {
	if (index < currentIdx) {
		return "complete";
	}
	if (index === currentIdx) {
		return "current";
	}
	return "upcoming";
}

/**
 * Progress strip rendered on the right edge of the wizard's heading row.
 *
 * The whole strip is a single segmented **button group** — one rounded,
 * divider-ringed container (surface +1) holding every step packed together —
 * so the steps read as one control rather than a scatter of free-floating
 * dots. Each step is a small checkbox following the in-app Toggle convention:
 *   - completed → teal-filled square with a white tick. Rendered as a *button*
 *                 so clicking it walks the wizard back to that step.
 *   - current   → empty square with a 2px accent ring + the step's label.
 *   - upcoming  → empty square on the parent surface (+2 lift) with a faint
 *                 divider-strong ring; non-interactive.
 *
 * Only the current step's label is rendered to keep the strip compact and
 * legible against the heading; completed/upcoming steps are box-only with
 * `sr-only` labels for screen readers.
 */
export function StepIndicator({ steps, current, onSelect }: StepIndicatorProps) {
	const substrate = useSurface();
	const groupBox = surfaceBg(Math.min(substrate + 1, 8));
	const upcomingBox = surfaceBg(Math.min(substrate + 2, 8));
	const currentIdx = steps.findIndex((s) => s.id === current);
	return (
		<ol
			aria-label="Setup progress"
			className={cn(
				"flex shrink-0 items-center gap-1 rounded-md p-1 font-mono text-xs-tight uppercase tracking-[0.14em] ring-1 ring-divider",
				groupBox,
			)}
		>
			{steps.map((step, i) => {
				const status = statusFor(i, currentIdx);
				const navigable = status === "complete" && onSelect != null;
				return (
					<li
						aria-current={status === "current" ? "step" : undefined}
						className="flex items-center"
						key={step.id}
					>
						<StepBox
							label={step.label}
							navigable={navigable}
							onSelect={navigable ? () => onSelect?.(step.id) : undefined}
							status={status}
							upcomingBox={upcomingBox}
						/>
						<AnimatePresence initial={false} mode="popLayout">
							{status === "current" ? (
								<m.span
									animate={{ opacity: 1, width: "auto", x: 0 }}
									className="overflow-hidden whitespace-nowrap pr-1 pl-1.5 text-accent"
									exit={{ opacity: 0, width: 0, x: -4 }}
									initial={{ opacity: 0, width: 0, x: 4 }}
									key="current-label"
									transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
								>
									{step.label}
								</m.span>
							) : (
								<span className="sr-only" key="sr-label">
									{step.label}
								</span>
							)}
						</AnimatePresence>
					</li>
				);
			})}
		</ol>
	);
}

interface StepBoxProps {
	label: string;
	navigable: boolean;
	onSelect: (() => void) | undefined;
	status: StepStatus;
	upcomingBox: string;
}

function StepBox({
	label,
	navigable,
	onSelect,
	status,
	upcomingBox,
}: StepBoxProps) {
	const box = (
		<m.span
			aria-hidden
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded-sm transition-colors duration-150",
				status === "complete" && "bg-teal text-white ring-1 ring-teal-hover",
				status === "current" &&
					"bg-transparent shadow-[0_0_6px_var(--color-accent-glow-strong)] ring-2 ring-accent",
				status === "upcoming" && cn(upcomingBox, "ring-1 ring-divider-strong"),
			)}
			layout
			transition={{
				type: "spring",
				stiffness: 520,
				damping: 34,
				mass: 0.55,
			}}
		>
			<AnimatePresence initial={false} mode="wait">
				{status === "complete" ? (
					<m.span
						animate={{ opacity: 1, rotate: 0, scale: 1 }}
						className="inline-flex"
						exit={{ opacity: 0, rotate: -20, scale: 0.4 }}
						initial={{ opacity: 0, rotate: -35, scale: 0.35 }}
						key="complete"
						transition={{ type: "spring", stiffness: 620, damping: 28 }}
					>
						<HugeiconsIcon icon={Tick02Icon} size={10} strokeWidth={3} />
					</m.span>
				) : null}
			</AnimatePresence>
		</m.span>
	);

	if (!navigable) {
		return box;
	}
	return (
		<m.button
			aria-label={`Go back to ${label}`}
			className="flex cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1"
			onClick={onSelect}
			type="button"
			whileHover={{ y: -1 }}
			whileTap={{ scale: 0.9 }}
		>
			{box}
		</m.button>
	);
}

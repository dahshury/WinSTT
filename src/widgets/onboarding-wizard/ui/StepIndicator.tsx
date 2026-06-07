import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, m } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import type { OnboardingStepId } from "../model/wizard-store";

type StepStatus = "complete" | "current" | "upcoming";

interface StepIndicatorProps {
	readonly current: OnboardingStepId;
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
 * Each step renders as a small checkbox that follows the in-app convention
 * used by the Toggle component:
 *   - completed → teal-filled square with a white tick (mirrors a toggle's
 *                 on-state colour signal)
 *   - current   → empty square with a 2px accent ring (single brand moment)
 *   - upcoming  → empty square on the parent surface (+2 lift) with a faint
 *                 divider-strong ring
 *
 * Only the current step's label is rendered to keep the strip compact and
 * legible against the heading; completed/upcoming steps are dot-only with
 * `sr-only` labels for screen readers.
 */
export function StepIndicator({ steps, current }: StepIndicatorProps) {
	const substrate = useSurface();
	const upcomingBox = surfaceBg(Math.min(substrate + 2, 8));
	const currentIdx = steps.findIndex((s) => s.id === current);
	return (
		<ol
			aria-label="Setup progress"
			className="flex shrink-0 items-center gap-1.5 font-mono text-xs-tight uppercase tracking-[0.14em]"
		>
			{steps.map((step, i) => {
				const status = statusFor(i, currentIdx);
				return (
					<li
						aria-current={status === "current" ? "step" : undefined}
						className="flex items-center gap-1.5"
						key={step.id}
					>
						<m.span
							aria-hidden
							className={cn(
								"flex size-4 shrink-0 items-center justify-center rounded-sm transition-colors duration-150",
								status === "complete" &&
									"bg-teal text-white ring-1 ring-teal-hover",
								status === "current" &&
									"bg-transparent shadow-[0_0_6px_var(--color-accent-glow-strong)] ring-2 ring-accent",
								status === "upcoming" &&
									cn(upcomingBox, "ring-1 ring-divider-strong"),
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
										<HugeiconsIcon
											icon={Tick02Icon}
											size={10}
											strokeWidth={3}
										/>
									</m.span>
								) : null}
							</AnimatePresence>
						</m.span>
						<AnimatePresence initial={false} mode="popLayout">
							{status === "current" ? (
								<m.span
									animate={{ opacity: 1, width: "auto", x: 0 }}
									className="overflow-hidden whitespace-nowrap text-accent"
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

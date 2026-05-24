import { Switch } from "@base-ui/react/switch";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";

export interface ToggleProps {
	"aria-label"?: string | undefined;
	checked: boolean;
	disabled?: boolean | undefined;
	label?: string | undefined;
	onCheckedChange: (checked: boolean) => void;
}

export function Toggle({
	checked,
	onCheckedChange,
	disabled,
	"aria-label": ariaLabel,
	label,
}: ToggleProps) {
	const substrate = useSurface();
	// Two-step lift on the track + four-step lift on the thumb so even on
	// a high substrate (inside an ElevatedSurface) the pill reads as a real
	// raised control rather than blending. The hairline ring picks out the
	// edge regardless of substrate.
	const trackLevel = Math.min(substrate + 2, 8);
	const thumbLevel = Math.min(substrate + 4, 8);
	const switchEl = (
		<Switch.Root
			aria-label={ariaLabel ?? label}
			checked={checked}
			className={cn(
				"group/switch relative flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-[3px] ring-1 ring-divider-strong ring-inset transition-colors duration-150 ease-linear motion-reduce:transition-none",
				"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
				surfaceBg(trackLevel),
				// When checked, the whole track fills with teal so the on-state
				// reads from across the panel — strong colour signal, not just
				// a quietly shifted thumb.
				"data-[checked]:bg-teal data-[checked]:ring-teal-hover",
				disabled && "cursor-not-allowed opacity-50"
			)}
			disabled={disabled}
			onCheckedChange={onCheckedChange}
		>
			<Switch.Thumb
				className={cn(
					"pointer-events-none h-3.5 w-3.5 origin-center rounded-full shadow-sm ring-1 ring-foreground/15 transition-[transform,background-color,width,height] duration-150 ease-out motion-reduce:transition-none",
					surfaceBg(thumbLevel),
					"data-[checked]:translate-x-4 data-[checked]:bg-white data-[checked]:ring-white/40",
					"group-hover/switch:w-[18px] group-hover/switch:not-disabled:data-[checked]:translate-x-[14px]",
					"group-active/switch:h-3 group-active/switch:w-5 group-active/switch:not-disabled:data-[checked]:translate-x-3"
				)}
			/>
		</Switch.Root>
	);
	if (!label) {
		return switchEl;
	}
	return (
		<span className="inline-flex select-none items-center gap-2">
			{switchEl}
			<button
				aria-hidden="true"
				className={cn(
					"text-body transition-colors duration-150",
					checked ? "text-foreground" : "text-foreground-muted",
					disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
				)}
				disabled={disabled}
				onClick={() => onCheckedChange(!checked)}
				tabIndex={-1}
				type="button"
			>
				{label}
			</button>
		</span>
	);
}

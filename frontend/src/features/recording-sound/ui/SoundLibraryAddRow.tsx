import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Button } from "@/shared/ui/button";

interface SoundLibraryAddRowProps {
	label: string;
	onClick: () => void;
}

export function SoundLibraryAddRow({ label, onClick }: SoundLibraryAddRowProps): ReactNode {
	// A clean borderless add row that picks up the same neutral hover wash as the
	// list rows. The plus sits in the radio column (no dashed circle — dashed
	// reads as a drop zone, which the FF language avoids).
	return (
		<Button
			aria-label={label}
			className="group relative z-raised flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-foreground-muted transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground"
			onClick={onClick}
		>
			<span className="flex size-[15px] shrink-0 items-center justify-center text-foreground-muted transition-colors duration-150 group-hover:text-foreground">
				<HugeiconsIcon icon={PlusSignIcon} size={13} />
			</span>
			<span className="font-medium text-body-sm">{label}</span>
		</Button>
	);
}

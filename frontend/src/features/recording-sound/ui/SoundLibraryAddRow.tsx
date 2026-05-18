"use client";

import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Button } from "@/shared/ui/button";

interface SoundLibraryAddRowProps {
	label: string;
	onClick: () => void;
}

export function SoundLibraryAddRow({ label, onClick }: SoundLibraryAddRowProps): ReactNode {
	return (
		<Button
			aria-label={label}
			className="group flex items-center gap-3 px-3 py-2.5 text-foreground-dim transition-colors duration-150 hover:bg-surface-3/60 hover:text-foreground"
			onClick={onClick}
		>
			<span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-3 ring-1 ring-divider-strong group-hover:ring-foreground-muted">
				<HugeiconsIcon icon={PlusSignIcon} size={10} />
			</span>
			<span className="font-medium text-body-sm">{label}</span>
		</Button>
	);
}

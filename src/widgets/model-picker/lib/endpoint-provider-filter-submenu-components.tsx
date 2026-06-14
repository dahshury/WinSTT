"use client";

import { Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

interface SelectedTickProps {
	visible: boolean;
}

export function SelectedTick({ visible }: SelectedTickProps) {
	if (!visible) {
		return null;
	}
	return (
		<HugeiconsIcon className="ms-2 size-4 text-accent" icon={Tick01Icon} />
	);
}

import { shouldShowCountBadge } from "./parameters-filter-submenu-utils";

interface SelectedCountBadgeProps {
	count: number;
}

export function SelectedCountBadge({ count }: SelectedCountBadgeProps) {
	if (!shouldShowCountBadge(count)) {
		return null;
	}
	return (
		<span className="ml-auto rounded-full bg-foreground/[0.10] px-1.5 py-0.5 text-foreground-secondary text-xs-tight tabular-nums">
			{count}
		</span>
	);
}

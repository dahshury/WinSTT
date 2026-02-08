import type { ReactNode } from "react";

export function Kbd({ children, className = "" }: { children: ReactNode; className?: string }) {
	return (
		<kbd
			className={`inline-flex items-center justify-center rounded-[6px] border border-border bg-surface-tertiary px-1.5 py-0.5 font-mono text-foreground text-xs leading-none ${className}`}
		>
			{children}
		</kbd>
	);
}

export function KbdGroup({
	children,
	className = "",
}: {
	children: ReactNode;
	className?: string;
}) {
	return <span className={`inline-flex items-center gap-0.5 ${className}`}>{children}</span>;
}

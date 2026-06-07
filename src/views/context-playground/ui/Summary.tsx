import type { ContextDebugReport } from "@/shared/api/context-debug-types";
import { cn } from "@/shared/lib/cn";

// --- Summary chips ------------------------------------------------------

export function Summary({ report }: { report: ContextDebugReport }) {
	const s = report.rawSnapshot;
	return (
		<div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
			<Chip label="App" value={s.appExe || "—"} />
			<Chip label="URL" value={s.url || "—"} />
			<Chip
				label="IDE"
				tone={report.isIde ? "accent" : "muted"}
				value={report.isIde ? "yes" : "no"}
			/>
			<Chip
				label="Terminal"
				tone={report.isTerminal ? "warning" : "muted"}
				value={report.isTerminal ? "yes" : "no"}
			/>
			<Chip
				className="col-span-2 sm:col-span-3"
				label="Window"
				value={s.windowTitle || "—"}
			/>
			<Chip
				className="col-span-2 sm:col-span-3"
				label="Focused field"
				value={s.elementName || "—"}
			/>
			<Chip
				label="Caret split"
				tone={report.hasCaret ? "success" : "muted"}
				value={report.hasCaret ? "yes" : "no"}
			/>
			<Chip
				label="Denied"
				tone={report.denied ? "error" : "success"}
				value={report.denied ? "yes" : "no"}
			/>
			<Chip
				label="Contentless"
				tone={report.contentless ? "warning" : "muted"}
				value={report.contentless ? "yes" : "no"}
			/>
			<Chip
				label="OCR used"
				tone={report.ocrUsed ? "warning" : "muted"}
				value={report.ocrUsed ? "yes" : "no"}
			/>
		</div>
	);
}

type ChipTone = "accent" | "error" | "muted" | "success" | "warning";

function Chip({
	label,
	value,
	tone,
	className,
}: {
	className?: string;
	label: string;
	tone?: ChipTone;
	value: string;
}) {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col gap-0.5 rounded border border-border bg-surface-secondary px-2 py-1",
				className,
			)}
		>
			<span className="text-[10px] text-foreground-dim uppercase tracking-wide">
				{label}
			</span>
			<span
				className={cn("truncate font-mono text-[11px]", toneClass(tone))}
				title={value}
			>
				{value}
			</span>
		</div>
	);
}

function toneClass(tone: ChipTone | undefined): string {
	switch (tone) {
		case "accent":
			return "text-accent";
		case "success":
			return "text-success";
		case "warning":
			return "text-warning";
		case "error":
			return "text-error";
		case "muted":
			return "text-foreground-muted";
		default:
			return "text-foreground";
	}
}

/* eslint-disable i18next/no-literal-string -- debug-only window, not user-facing/shipped */
import { cn } from "@/shared/lib/cn";

// --- Primitives ---------------------------------------------------------

export function Section({
	title,
	subtitle,
	children,
}: {
	children: React.ReactNode;
	subtitle?: string;
	title: string;
}) {
	return (
		<section className="rounded-md border border-border bg-surface-primary p-2">
			<div className="mb-1.5 flex items-baseline gap-2">
				<h2 className="font-semibold text-[11px] text-foreground-secondary uppercase tracking-wide">
					{title}
				</h2>
				{subtitle && (
					<span className="text-[10px] text-foreground-dim">{subtitle}</span>
				)}
			</div>
			{children}
		</section>
	);
}

export function Field({
	label,
	value,
	tall,
}: {
	label: string;
	tall?: boolean;
	value: string | undefined;
}) {
	return (
		<div>
			<div className="mb-0.5 text-[10px] text-foreground-dim">{label}</div>
			<Pre tall={tall ?? false} value={value} />
		</div>
	);
}

export function Pre({
	value,
	tall,
}: {
	tall?: boolean;
	value: string | undefined;
}) {
	const text = value ?? "";
	return (
		<pre
			className={cn(
				"overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-surface px-2 py-1.5 font-mono text-[11px] text-foreground-secondary",
				tall ? "max-h-64" : "max-h-40",
			)}
		>
			{text.length > 0 ? (
				text
			) : (
				<span className="text-foreground-dim">(empty)</span>
			)}
		</pre>
	);
}

export function Banner({
	tone,
	children,
}: {
	children: React.ReactNode;
	tone: "error" | "muted" | "warning";
}) {
	return (
		<div
			className={cn(
				"rounded border px-2.5 py-1.5 text-[11px]",
				bannerToneClass(tone),
			)}
		>
			{children}
		</div>
	);
}

function bannerToneClass(tone: "error" | "muted" | "warning"): string {
	switch (tone) {
		case "error":
			return "border-error/40 bg-error-dim text-error";
		case "warning":
			return "border-warning/40 bg-warning-dim text-warning";
		default:
			return "border-border bg-surface-secondary text-foreground-muted";
	}
}

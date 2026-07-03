import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";

export interface AuthorBadgeProps {
	className?: string;
	/** Fallback glyph shown when there is no brand logo image. */
	icon?: IconSvgElement;
	/** Author / maker / publisher display name, e.g. "Google", "NVIDIA". */
	label: string;
	/** Already resolved logo URL (run local asset paths through `publicAsset`). */
	logoSrc?: string | null;
	/** Dimmed variant — the outgoing model in a swap transition. */
	muted?: boolean;
}

/**
 * The one author/maker badge shared by EVERY model-selector trigger (STT main
 * + realtime, cloud STT, TTS, Ollama, OpenRouter). A prominent brand logo + the
 * maker's name in a soft pill, so the model choice leads with a big, legible
 * mark and every picker reads identically. Previously each selector rolled its
 * own tiny 12px chip — this is the single, larger, DRY source.
 */
export function AuthorBadge({
	className,
	icon,
	label,
	logoSrc,
	muted = false,
}: AuthorBadgeProps) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 font-semibold text-body-sm leading-none ring-1 ring-inset",
				muted
					? "bg-foreground/[0.03] text-foreground-dim ring-divider"
					: "bg-foreground/[0.06] text-foreground-secondary ring-divider-strong",
				className,
			)}
		>
			{logoSrc ? (
				<img
					alt=""
					className={cn(
						"size-5 shrink-0 rounded object-contain",
						muted && "opacity-60",
					)}
					height={20}
					loading="eager"
					src={logoSrc}
					width={20}
				/>
			) : icon ? (
				<HugeiconsIcon className="size-5 shrink-0" icon={icon} />
			) : null}
			{label}
		</span>
	);
}

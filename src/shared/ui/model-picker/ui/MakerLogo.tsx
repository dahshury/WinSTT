import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * The square maker/brand mark rendered before a model name across every picker
 * — STT family headers, TTS engine headers/cards, Ollama publisher chips. One
 * component so the mark looks and behaves identically everywhere: an `<img>` of
 * the bundled logo when one exists, else a neutral chip holding a glyph or
 * initials. Previously each picker inlined its own `<img>`/fallback pair, which
 * drifted apart (rounded-[3px] vs -[4px], object-contain vs -cover, glyph vs
 * initials) — this collapses them onto one contract.
 *
 * `src` is an ALREADY-resolved URL (callers wrap raw catalog paths in
 * `publicAsset`); `null`/`undefined` renders `fallback` inside the neutral chip.
 */
export function MakerLogo({
	src,
	alt = "",
	fallback,
	className,
	fallbackClassName,
}: {
	src: string | null | undefined;
	alt?: string | undefined;
	/** Glyph (`<HugeiconsIcon />`) or initials shown when no `src` is bundled. */
	fallback: ReactNode;
	className?: string | undefined;
	/** Extra classes on the fallback chip only (e.g. initials typography). */
	fallbackClassName?: string | undefined;
}) {
	if (src) {
		return (
			<img
				alt={alt}
				className={cn(
					"size-4 shrink-0 rounded-[3px] object-contain",
					className,
				)}
				height={16}
				src={src}
				width={16}
			/>
		);
	}
	return (
		<span
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-foreground/[0.06] text-foreground-muted",
				fallbackClassName,
				className,
			)}
		>
			{fallback}
		</span>
	);
}

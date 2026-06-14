import { Heading } from "fumadocs-ui/components/heading";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/cn";

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

type GradientHeadingProps<T extends HeadingTag = "h1"> = Omit<
  ComponentPropsWithoutRef<T>,
  "as"
> & { as?: T };

/**
 * Docs heading with the WinSTT brand gradient painted across the text.
 *
 * Thin wrapper over fumadocs' {@link Heading}: we only layer a
 * `gradient-heading` class on top, so the anchor self-link, the
 * copy-to-clipboard button, and the TOC `id` all keep working. The gradient
 * itself lives in `docs-ui.css` (`.gradient-heading`); the copy button keeps
 * its own muted colour and stays readable.
 */
export function GradientHeading<T extends HeadingTag = "h1">({
  className,
  ...props
}: GradientHeadingProps<T>) {
  return <Heading className={cn("gradient-heading", className)} {...props} />;
}

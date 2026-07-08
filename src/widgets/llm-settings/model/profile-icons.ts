import {
	AiChat02Icon,
	AiMagicIcon,
	BubbleChatIcon,
	Mail01Icon,
	Note01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

/** A distinct glyph per SHIPPED post-processing preset, keyed by its stable
 *  built-in id (see `BUILTIN_CONFIGURATIONS`). User-made (custom) profiles fall
 *  back to the generic AI-magic glyph. */
const BUILTIN_PROFILE_ICONS: Record<string, IconSvgElement> = {
	"builtin:ai-prompt": AiChat02Icon,
	"builtin:casual-chat": BubbleChatIcon,
	"builtin:formal-email": Mail01Icon,
	"builtin:note-taking": Note01Icon,
};

/** The generic icon for a custom (user-created) post-processing profile. */
export const CUSTOM_PROFILE_ICON: IconSvgElement = AiMagicIcon;

/** Resolve the icon for a saved post-processing profile by id — a per-preset glyph
 *  for the shipped built-ins, and the generic custom glyph for everything else. */
export function iconForPostProcessingProfileId(id: string): IconSvgElement {
	return BUILTIN_PROFILE_ICONS[id] ?? CUSTOM_PROFILE_ICON;
}

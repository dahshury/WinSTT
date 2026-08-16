import {
	KeyboardIcon,
	MagicWand01Icon,
	VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { AssignableFeature } from "./configuration-assignment";

/** The three consumers, in the order the UI lists them. */
export const ASSIGNABLE_FEATURES = [
	"dictation",
	"transforms",
	"readAloud",
] as const satisfies readonly AssignableFeature[];

/** Icon + label for each consumer, shared by the header enable chips and the
 *  preset editor's "Used by" row so the two always name things identically. */
export const FEATURE_ICONS: Readonly<
	Record<AssignableFeature, IconSvgElement>
> = {
	dictation: KeyboardIcon,
	transforms: MagicWand01Icon,
	readAloud: VolumeHighIcon,
};

// `as const` so the values stay literal message keys — `Record<_, string>` would
// widen them and `t()` only accepts known keys.
export const FEATURE_LABEL_KEY = {
	dictation: "assignDictationTitle",
	transforms: "assignTransformsTitle",
	readAloud: "assignReadAloudTitle",
} as const satisfies Record<AssignableFeature, string>;

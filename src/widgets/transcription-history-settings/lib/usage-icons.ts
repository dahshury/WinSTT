import {
	AiMagicIcon,
	Briefcase01Icon,
	BubbleChatIcon,
	File01Icon,
	InfinityIcon,
	Mail01Icon,
	Note01Icon,
	SourceCodeIcon,
	TaskDone01Icon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

/**
 * Leading glyph per content category, keyed by the history-tag id (see
 * `historyTagLabel`). Pass to `UsageBars` for the categories breakdown; the
 * models breakdown leaves it off (model ids have no fixed icon). The rolled-up
 * "Other" row reuses the infinity glyph.
 */
export const CATEGORY_ICONS: Record<string, IconSvgElement> = {
	ai_prompt: AiMagicIcon,
	code: SourceCodeIcon,
	document: File01Icon,
	email: Mail01Icon,
	meeting: UserGroupIcon,
	note: Note01Icon,
	other: InfinityIcon,
	personal_message: BubbleChatIcon,
	task: TaskDone01Icon,
	work_message: Briefcase01Icon,
	__other__: InfinityIcon,
};

/**
 * Icons for the models breakdown. Model ids have no fixed logo (their maker logo
 * is resolved per-bucket), so this only badges the rolled-up "Other" row with the
 * same infinity glyph the categories breakdown uses — keeping the two lists'
 * roll-up rows visually consistent.
 */
export const MODEL_ICONS: Record<string, IconSvgElement> = {
	__other__: InfinityIcon,
};

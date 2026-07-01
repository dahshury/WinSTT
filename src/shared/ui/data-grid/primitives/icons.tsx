/**
 * lucide-react → @hugeicons shim for the vendored DiceUI data grid.
 *
 * The upstream grid imports a flat set of lucide icons; WinSTT standardises on
 * Hugeicons. Each lucide name used by the grid is re-exported here as a small
 * component that renders the closest Hugeicons glyph, so the vendored files need
 * only a path rewrite (`lucide-react` → this module) and stay otherwise intact.
 *
 * Icons render a plain `<svg>`, so parent `[&_svg]:size-4` utilities (shadcn
 * button convention the grid relies on) still control sizing.
 */
import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	Calendar03Icon,
	Cancel01Icon,
	CheckmarkSquare01Icon,
	Copy01Icon,
	Delete02Icon,
	DragDropVerticalIcon,
	Eraser01Icon,
	EqualSignIcon,
	File01Icon,
	File02Icon,
	FileAudioIcon,
	FileImageIcon,
	FileVideoIcon,
	FileZipIcon,
	FilterHorizontalIcon,
	HashIcon,
	Link01Icon,
	ListViewIcon,
	Menu01Icon,
	Pin02Icon,
	PinOffIcon as PinOffGlyph,
	PlusSignIcon,
	PresentationBarChart01Icon,
	Remove01Icon,
	Scissor01Icon,
	Search01Icon,
	Settings02Icon,
	SortingAZ02Icon,
	TaskDone01Icon,
	TextFontIcon,
	Tick02Icon,
	UnfoldLessIcon,
	UnfoldMoreIcon,
	Upload01Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SVGProps } from "react";

export interface LucideIconProps extends SVGProps<SVGSVGElement> {
	size?: number | string;
}

function makeIcon(icon: IconSvgElement) {
	return function Icon(props: LucideIconProps) {
		return (
			<HugeiconsIcon icon={icon} {...(props as Record<string, unknown>)} />
		);
	};
}

// Navigation / state
export const Check = makeIcon(Tick02Icon);
export const ChevronDown = makeIcon(ArrowDown01Icon);
export const ChevronDownIcon = makeIcon(ArrowDown01Icon);
export const ChevronUp = makeIcon(ArrowUp01Icon);
export const ChevronUpIcon = makeIcon(ArrowUp01Icon);
export const ChevronsDownUpIcon = makeIcon(UnfoldLessIcon);
export const ChevronsUpDown = makeIcon(UnfoldMoreIcon);
export const ArrowDownUp = makeIcon(SortingAZ02Icon);

// Actions
export const Plus = makeIcon(PlusSignIcon);
export const CopyIcon = makeIcon(Copy01Icon);
export const ScissorsIcon = makeIcon(Scissor01Icon);
export const EraserIcon = makeIcon(Eraser01Icon);
export const Trash2 = makeIcon(Delete02Icon);
export const Trash2Icon = makeIcon(Delete02Icon);
export const Upload = makeIcon(Upload01Icon);
export const SearchIcon = makeIcon(Search01Icon);
export const Settings2 = makeIcon(Settings02Icon);
export const X = makeIcon(Cancel01Icon);
export const XIcon = makeIcon(Cancel01Icon);
export const MinusIcon = makeIcon(Remove01Icon);
export const EqualIcon = makeIcon(EqualSignIcon);
export const GripVertical = makeIcon(DragDropVerticalIcon);

// Pin / view / filter / sort menus
export const PinIcon = makeIcon(Pin02Icon);
export const PinOffIcon = makeIcon(PinOffGlyph);
export const EyeOffIcon = makeIcon(ViewOffSlashIcon);
export const ListFilter = makeIcon(FilterHorizontalIcon);
export const ListIcon = makeIcon(ListViewIcon);
export const ListChecksIcon = makeIcon(TaskDone01Icon);
export const AlignVerticalSpaceAroundIcon = makeIcon(Menu01Icon);
export const CalendarIcon = makeIcon(Calendar03Icon);

// Cell-variant value type glyphs
const HashIconLucide = makeIcon(HashIcon);
export { HashIconLucide as HashIcon };
export const LinkIcon = makeIcon(Link01Icon);
export const BaselineIcon = makeIcon(TextFontIcon);
export const TextInitialIcon = makeIcon(TextFontIcon);
export const CheckSquareIcon = makeIcon(CheckmarkSquare01Icon);

// File-cell glyphs
export const File = makeIcon(File01Icon);
export const FileIcon = makeIcon(File01Icon);
export const FileText = makeIcon(File01Icon);
export const FileArchive = makeIcon(FileZipIcon);
export const FileAudio = makeIcon(FileAudioIcon);
export const FileImage = makeIcon(FileImageIcon);
export const FileVideo = makeIcon(FileVideoIcon);
export const FileSpreadsheet = makeIcon(File02Icon);
export const Presentation = makeIcon(PresentationBarChart01Icon);

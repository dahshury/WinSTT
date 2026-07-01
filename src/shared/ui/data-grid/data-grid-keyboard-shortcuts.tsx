import * as React from "react";
import {
	DataGridKeyboardShortcutsDialog,
	type ShortcutGroup,
} from "@/shared/ui/data-grid/data-grid-keyboard-shortcuts-dialog";

const SHORTCUT_KEY = "/";

export interface DataGridKeyboardShortcutsFeatures {
	enableSearch?: boolean;
	enableUndoRedo?: boolean;
	enablePaste?: boolean;
	enableRowAdd?: boolean;
	enableRowsDelete?: boolean;
}

interface DataGridKeyboardShortcutsProps {
	features?: DataGridKeyboardShortcutsFeatures;
}

function buildShortcutGroups(
	features: DataGridKeyboardShortcutsFeatures,
	modKey: string,
): ShortcutGroup[] {
	const {
		enableSearch = false,
		enableUndoRedo = false,
		enablePaste = false,
		enableRowAdd = false,
		enableRowsDelete = false,
	} = features;

	return [
		{
			title: "Navigation",
			shortcuts: [
				{
					keys: ["↑", "↓", "←", "→"],
					description: "Navigate between cells",
				},
				{
					keys: ["Tab"],
					description: "Move to next cell",
				},
				{
					keys: ["Shift", "Tab"],
					description: "Move to previous cell",
				},
				{
					keys: ["Home"],
					description: "Move to first column",
				},
				{
					keys: ["End"],
					description: "Move to last column",
				},
				{
					keys: [modKey, "↑"],
					description: "Move to first row (same column)",
				},
				{
					keys: [modKey, "↓"],
					description: "Move to last row (same column)",
				},
				{
					keys: [modKey, "←"],
					description: "Move to first column (same row)",
				},
				{
					keys: [modKey, "→"],
					description: "Move to last column (same row)",
				},
				{
					keys: [modKey, "Home"],
					description: "Move to first cell",
				},
				{
					keys: [modKey, "End"],
					description: "Move to last cell",
				},
				{
					keys: ["PgUp"],
					description: "Move up one page",
				},
				{
					keys: ["PgDn"],
					description: "Move down one page",
				},
				{
					keys: ["⌥", "↑"],
					description: "Scroll up one page",
				},
				{
					keys: ["⌥", "↓"],
					description: "Scroll down one page",
				},
				{
					keys: ["⌥", "PgUp"],
					description: "Scroll left one page of columns",
				},
				{
					keys: ["⌥", "PgDn"],
					description: "Scroll right one page of columns",
				},
			],
		},
		{
			title: "Selection",
			shortcuts: [
				{
					keys: ["Shift", "↑↓←→"],
					description: "Extend selection",
				},
				{
					keys: [modKey, "Shift", "↑"],
					description: "Select to top of table",
				},
				{
					keys: [modKey, "Shift", "↓"],
					description: "Select to bottom of table",
				},
				{
					keys: [modKey, "Shift", "←"],
					description: "Select to first column",
				},
				{
					keys: [modKey, "Shift", "→"],
					description: "Select to last column",
				},
				{
					keys: [modKey, "A"],
					description: "Select all cells",
				},
				{
					keys: [modKey, "Click"],
					description: "Toggle cell selection",
				},
				{
					keys: ["Shift", "Click"],
					description: "Select range",
				},
				{
					keys: ["Esc"],
					description: "Clear selection",
				},
			],
		},
		{
			title: "Editing",
			shortcuts: [
				{
					keys: ["Enter"],
					description: "Start editing cell",
				},
				{
					keys: ["F2"],
					description: "Start editing cell",
				},
				{
					keys: ["Double Click"],
					description: "Start editing cell",
				},
				...(enableRowAdd
					? [
							{
								keys: ["Shift", "Enter"],
								description: "Insert row below",
							},
						]
					: []),
				{
					keys: [modKey, "C"],
					description: "Copy selected cells",
				},
				{
					keys: [modKey, "X"],
					description: "Cut selected cells",
				},
				...(enablePaste
					? [
							{
								keys: [modKey, "V"],
								description: "Paste cells",
							},
						]
					: []),
				{
					keys: ["Delete"],
					description: "Clear selected cells",
				},
				{
					keys: ["Backspace"],
					description: "Clear selected cells",
				},
				...(enableRowsDelete
					? [
							{
								keys: [modKey, "Backspace"],
								description: "Delete selected rows",
							},
							{
								keys: [modKey, "Delete"],
								description: "Delete selected rows",
							},
						]
					: []),
				...(enableUndoRedo
					? [
							{
								keys: [modKey, "Z"],
								description: "Undo last action",
							},
							{
								keys: [modKey, "Shift", "Z"],
								description: "Redo last action",
							},
						]
					: []),
			],
		},
		...(enableSearch
			? [
					{
						title: "Search",
						shortcuts: [
							{
								keys: [modKey, "F"],
								description: "Open search",
							},
							{
								keys: ["Enter"],
								description: "Next match",
							},
							{
								keys: ["Shift", "Enter"],
								description: "Previous match",
							},
							{
								keys: ["Esc"],
								description: "Close search",
							},
						],
					},
				]
			: []),
		{
			title: "Filtering",
			shortcuts: [
				{
					keys: [modKey, "Shift", "F"],
					description: "Toggle the filter menu",
				},
				{
					keys: ["Backspace"],
					description: "Remove filter (when focused)",
				},
				{
					keys: ["Delete"],
					description: "Remove filter (when focused)",
				},
			],
		},
		{
			title: "Sorting",
			shortcuts: [
				{
					keys: [modKey, "Shift", "S"],
					description: "Toggle the sort menu",
				},
				{
					keys: ["Backspace"],
					description: "Remove sort (when focused)",
				},
				{
					keys: ["Delete"],
					description: "Remove sort (when focused)",
				},
			],
		},
		{
			title: "General",
			shortcuts: [
				{
					keys: [modKey, "/"],
					description: "Show keyboard shortcuts",
				},
			],
		},
	];
}

function filterShortcutGroups(
	groups: ShortcutGroup[],
	input: string,
): ShortcutGroup[] {
	if (!input.trim()) return groups;

	const query = input.toLowerCase();
	return groups.reduce<ShortcutGroup[]>((acc, group) => {
		const shortcuts = group.shortcuts.filter(
			(shortcut) =>
				shortcut.description.toLowerCase().includes(query) ||
				shortcut.keys.some((key) => key.toLowerCase().includes(query)),
		);
		if (shortcuts.length > 0) {
			acc.push({ ...group, shortcuts });
		}
		return acc;
	}, []);
}

const IS_MAC =
	typeof navigator !== "undefined"
		? /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
		: false;

const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

/** Stable empty-features default so the prop identity stays constant across renders. */
const EMPTY_FEATURES: DataGridKeyboardShortcutsFeatures = {};

export function DataGridKeyboardShortcuts({
	features = EMPTY_FEATURES,
}: DataGridKeyboardShortcutsProps) {
	const [open, setOpen] = React.useState(false);
	const [input, setInput] = React.useState("");
	const inputRef = React.useRef<HTMLInputElement>(null);

	const onOpenChange = (isOpen: boolean) => {
		setOpen(isOpen);
		if (!isOpen) {
			setInput("");
		}
	};

	const onInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		setInput(event.target.value);
	};

	const shortcutGroups = buildShortcutGroups(features, MOD_KEY);
	const filteredGroups = filterShortcutGroups(shortcutGroups, input);

	React.useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if ((event.ctrlKey || event.metaKey) && event.key === SHORTCUT_KEY) {
				event.preventDefault();
				setOpen(true);
			}
		}

		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
		};
	}, []);

	return (
		<DataGridKeyboardShortcutsDialog
			open={open}
			onOpenChange={onOpenChange}
			input={input}
			onInputChange={onInputChange}
			inputRef={inputRef}
			filteredGroups={filteredGroups}
		/>
	);
}

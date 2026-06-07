import { Radio } from "@base-ui/react/radio";
import {
	Delete02Icon,
	PauseIcon,
	PencilEdit01Icon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { fontWeights } from "@/shared/lib/font-weight";
import { Button } from "@/shared/ui/button";
import { TextField } from "@/shared/ui/text-field";
import { Tooltip } from "@/shared/ui/tooltip";
import type { SoundLibraryItem } from "../model/recording-sound";

interface SoundLibraryRowProps {
	active: boolean;
	confirmDeleteLabel?: string;
	deleteLabel: string;
	isPlaying: boolean;
	item: SoundLibraryItem;
	labels: {
		pause: string;
		play: string;
	};
	onDelete?: (item: SoundLibraryItem) => void;
	onRename?: (item: SoundLibraryItem, newName: string) => void;
	onTogglePreview: (item: SoundLibraryItem) => void;
	renameLabel: string;
}

/**
 * fluidfunctionalism radio glyph: a thin neutral ring that simply vanishes when
 * selected, leaving a solid foreground dot. No accent, no glow, no fill —
 * selection is carried by the gliding pill behind the row plus this dot.
 */
function RowRadio(): ReactNode {
	return (
		<span
			className={cn(
				"relative flex size-[15px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-solid transition-[border-color] duration-150",
				"border-foreground/30 group-data-[checked]:border-transparent group-hover:border-foreground/55",
			)}
		>
			<Radio.Indicator
				className="size-[7px] rounded-full bg-foreground transition-transform duration-150 ease-out data-[checked]:scale-100 data-[unchecked]:scale-0"
				keepMounted
			/>
		</span>
	);
}

interface PlayButtonProps {
	isPlaying: boolean;
	labels: { pause: string; play: string };
	onClick: () => void;
}

/**
 * Ghost transport control. Idle is a muted icon that picks up a faint neutral
 * wash on hover; playing settles into a soft neutral chip so the active sound
 * reads without a drop of color. `active:scale-95` gives the press a physical tap.
 */
function PlayButton({
	isPlaying,
	labels,
	onClick,
}: PlayButtonProps): ReactNode {
	return (
		<Tooltip content={isPlaying ? labels.pause : labels.play}>
			<Button
				aria-label={isPlaying ? labels.pause : labels.play}
				className={cn(
					"flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-150 active:scale-95",
					isPlaying
						? "bg-foreground/15 text-foreground hover:bg-foreground/25"
						: "bg-transparent text-foreground-muted hover:bg-foreground/10 hover:text-foreground",
				)}
				onClick={(e) => {
					e.stopPropagation();
					onClick();
				}}
			>
				<HugeiconsIcon icon={isPlaying ? PauseIcon : PlayIcon} size={14} />
			</Button>
		</Tooltip>
	);
}

interface RowMetaEditorProps {
	initialName: string;
	onCommit: (next: string) => void;
	onEditingChange: (editing: boolean) => void;
}

/**
 * Rename input. Mounted only while editing, so `draft` is genuine fresh local
 * state seeded from the name at edit-start — no prop-derived state to keep in
 * sync. The callback ref focuses + selects on mount instead of an effect.
 */
function RowMetaEditor({
	initialName,
	onCommit,
	onEditingChange,
}: RowMetaEditorProps): ReactNode {
	const [draft, setDraft] = useState(() => initialName);

	const commit = (): void => {
		const trimmed = draft.trim();
		if (!trimmed || trimmed === initialName) {
			onEditingChange(false);
			return;
		}
		onCommit(trimmed);
		onEditingChange(false);
	};

	const handleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === "Enter") {
			e.preventDefault();
			commit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			onEditingChange(false);
		}
	};

	return (
		<div className="min-w-0 flex-1">
			<TextField
				aria-label="Rename sound"
				onBlur={commit}
				onChange={(e) => setDraft(e.target.value)}
				// The row wrapper turns clicks/keys into select/activate; the input
				// is the interactive element here, so stop the bubble at the input
				// itself rather than on a non-interactive wrapper div.
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					e.stopPropagation();
					handleKey(e);
				}}
				ref={(node) => {
					node?.focus();
					node?.select();
				}}
				value={draft}
			/>
		</div>
	);
}

interface RowMetaProps {
	active: boolean;
	editing: boolean;
	item: SoundLibraryItem;
	onCommit: (next: string) => void;
	onEditingChange: (editing: boolean) => void;
}

function RowMeta({
	active,
	editing,
	item,
	onCommit,
	onEditingChange,
}: RowMetaProps): ReactNode {
	if (editing) {
		return (
			<RowMetaEditor
				initialName={item.name}
				onCommit={onCommit}
				onEditingChange={onEditingChange}
			/>
		);
	}

	// Selection drives the same weight + tone shift the FF radio/checkbox labels
	// use: muted by default, foreground + semibold when active.
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<span
				className={cn(
					"truncate text-body transition-[color,font-variation-settings] duration-150",
					active ? "text-foreground" : "text-foreground-muted",
				)}
				style={{
					fontVariationSettings: active
						? fontWeights.semibold
						: fontWeights.normal,
				}}
				title={item.name}
			>
				{item.name}
			</span>
		</div>
	);
}

interface RowActionButtonProps {
	className?: string;
	icon: typeof PencilEdit01Icon;
	label: string;
	onClick: () => void;
}

function RowActionButton({
	className,
	icon,
	label,
	onClick,
}: RowActionButtonProps): ReactNode {
	return (
		<Tooltip content={label}>
			<Button
				aria-label={label}
				className={cn(
					"flex size-7 items-center justify-center rounded-md text-foreground-dim transition-colors duration-150 active:scale-95",
					className,
				)}
				onClick={(e) => {
					e.stopPropagation();
					onClick();
				}}
			>
				<HugeiconsIcon icon={icon} size={13} />
			</Button>
		</Tooltip>
	);
}

export function SoundLibraryRow({
	item,
	active,
	isPlaying,
	labels,
	renameLabel,
	deleteLabel,
	onTogglePreview,
	onRename,
	onDelete,
}: SoundLibraryRowProps) {
	const [editing, setEditing] = useState(false);
	const canRename = !item.isDefault && Boolean(onRename);
	const canDelete = !item.isDefault && Boolean(onDelete);

	return (
		// Transparent row: the selected state is the gliding neutral pill rendered
		// behind the list (SoundLibraryHighlight). `z-raised` lifts the row's
		// content above that pill; the hover wash is a plain CSS pill, suppressed
		// while active so it never double-paints over the selected pill.
		<Radio.Root
			aria-label={item.name}
			className={cn(
				"group relative z-raised block rounded-lg outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent",
				active ? "" : "hover:bg-foreground/[0.05]",
			)}
			data-sound-row={item.id}
			value={item.id}
		>
			<div className="pointer-events-none relative flex w-full items-center gap-3 px-3 py-2.5">
				<RowRadio />
				<div className="pointer-events-auto">
					<PlayButton
						isPlaying={isPlaying}
						labels={{ play: labels.play, pause: labels.pause }}
						onClick={() => onTogglePreview(item)}
					/>
				</div>
				<RowMeta
					active={active}
					editing={editing}
					item={item}
					onCommit={(next) => onRename?.(item, next)}
					onEditingChange={setEditing}
				/>
				<div
					className={cn(
						"pointer-events-auto flex shrink-0 items-center gap-0.5 transition-opacity duration-150",
						active
							? "opacity-100"
							: "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
					)}
				>
					{canRename ? (
						<RowActionButton
							className="hover:bg-foreground/10 hover:text-foreground"
							icon={PencilEdit01Icon}
							label={renameLabel}
							onClick={() => setEditing(true)}
						/>
					) : null}
					{canDelete ? (
						<RowActionButton
							className="hover:bg-error/15 hover:text-error"
							icon={Delete02Icon}
							label={deleteLabel}
							onClick={() => onDelete?.(item)}
						/>
					) : null}
				</div>
			</div>
		</Radio.Root>
	);
}

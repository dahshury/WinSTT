import {
	CheckmarkCircle02Icon,
	Delete02Icon,
	PauseIcon,
	PencilEdit01Icon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { cn } from "@/shared/lib/cn";
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
		active: string;
		default: string;
		pause: string;
		play: string;
	};
	onDelete?: (item: SoundLibraryItem) => void;
	onRename?: (item: SoundLibraryItem, newName: string) => void;
	onSelect: (item: SoundLibraryItem) => void;
	onTogglePreview: (item: SoundLibraryItem) => void;
	renameLabel: string;
}

interface RowRadioProps {
	active: boolean;
}

function RowRadio({ active }: RowRadioProps): ReactNode {
	return (
		<span
			className={cn(
				"relative flex size-4 shrink-0 items-center justify-center rounded-full ring-1 transition-[box-shadow,background-color] duration-150",
				active
					? "bg-accent/15 shadow-[0_0_0_3px] shadow-accent/15 ring-accent"
					: "bg-surface-3 ring-divider-strong group-hover:ring-foreground-muted"
			)}
		>
			<span
				className={cn(
					"size-1.5 rounded-full bg-accent transition-transform duration-150",
					active ? "scale-100" : "scale-0"
				)}
			/>
		</span>
	);
}

interface PlayButtonProps {
	isPlaying: boolean;
	labels: { pause: string; play: string };
	onClick: () => void;
}

function PlayButton({ isPlaying, labels, onClick }: PlayButtonProps): ReactNode {
	return (
		<Tooltip content={isPlaying ? labels.pause : labels.play}>
			<Button
				aria-label={isPlaying ? labels.pause : labels.play}
				className={cn(
					"flex size-8 shrink-0 items-center justify-center rounded-full transition-[background-color,transform] duration-150",
					isPlaying
						? "bg-accent text-on-accent shadow-[0_0_0_3px] shadow-accent/20"
						: "bg-surface-4 text-foreground hover:bg-surface-5 active:scale-95"
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
function RowMetaEditor({ initialName, onCommit, onEditingChange }: RowMetaEditorProps): ReactNode {
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
	labels: { active: string; default: string };
	onCommit: (next: string) => void;
	onEditingChange: (editing: boolean) => void;
}

function RowMeta({
	editing,
	active,
	item,
	labels,
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

	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<span className="truncate font-medium text-body text-foreground" title={item.name}>
				{item.name}
			</span>
			{item.isDefault ? <Chip>{labels.default}</Chip> : null}
			{active ? <Chip variant="accent">{labels.active}</Chip> : null}
		</div>
	);
}

interface ChipProps {
	children: ReactNode;
	variant?: "default" | "accent";
}

function Chip({ children, variant = "default" }: ChipProps): ReactNode {
	const classes =
		variant === "accent"
			? "border-accent/40 bg-accent/15 text-accent"
			: "border-divider-strong bg-surface-4 text-foreground-dim";
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-sm border px-1.5 py-px font-mono font-semibold text-[9px] uppercase leading-none tracking-wider",
				classes
			)}
		>
			{children}
		</span>
	);
}

export function SoundLibraryRow({
	item,
	active,
	isPlaying,
	labels,
	renameLabel,
	deleteLabel,
	onSelect,
	onTogglePreview,
	onRename,
	onDelete,
}: SoundLibraryRowProps) {
	const [editing, setEditing] = useState(false);
	const canRename = !item.isDefault && Boolean(onRename);
	const canDelete = !item.isDefault && Boolean(onDelete);

	return (
		// biome-ignore lint/a11y/useSemanticElements: row is a custom radio-style picker with nested action buttons; an <input type=radio> doesn't accept the layout
		<div
			aria-checked={active}
			aria-label={item.name}
			className={cn(
				"group relative flex items-center gap-3 px-3 py-2.5 transition-colors duration-150",
				active
					? "bg-gradient-to-r from-accent/8 via-accent/3 to-transparent"
					: "hover:bg-surface-3/60"
			)}
			onClick={() => onSelect(item)}
			onKeyDown={(e) => {
				if (e.key === " " || e.key === "Enter") {
					e.preventDefault();
					onSelect(item);
				}
			}}
			role="radio"
			tabIndex={0}
		>
			{active ? (
				<span
					aria-hidden="true"
					className="absolute top-1/2 left-0 h-7 w-[2px] -translate-y-1/2 rounded-r-full bg-accent shadow-[0_0_8px] shadow-accent/60"
				/>
			) : null}
			<RowRadio active={active} />
			<PlayButton
				isPlaying={isPlaying}
				labels={{ play: labels.play, pause: labels.pause }}
				onClick={() => onTogglePreview(item)}
			/>
			<RowMeta
				active={active}
				editing={editing}
				item={item}
				labels={{ active: labels.active, default: labels.default }}
				onCommit={(next) => onRename?.(item, next)}
				onEditingChange={setEditing}
			/>
			<div
				className={cn(
					"flex shrink-0 items-center gap-0.5 transition-opacity duration-150",
					active
						? "opacity-100"
						: "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
				)}
			>
				{canRename ? (
					<Tooltip content={renameLabel}>
						<Button
							aria-label={renameLabel}
							className="flex size-7 items-center justify-center rounded-md text-foreground-dim transition-colors duration-150 hover:bg-surface-4 hover:text-foreground"
							onClick={(e) => {
								e.stopPropagation();
								setEditing(true);
							}}
						>
							<HugeiconsIcon icon={PencilEdit01Icon} size={13} />
						</Button>
					</Tooltip>
				) : null}
				{canDelete ? (
					<Tooltip content={deleteLabel}>
						<Button
							aria-label={deleteLabel}
							className="flex size-7 items-center justify-center rounded-md text-foreground-dim transition-colors duration-150 hover:bg-error/15 hover:text-error"
							onClick={(e) => {
								e.stopPropagation();
								onDelete?.(item);
							}}
						>
							<HugeiconsIcon icon={Delete02Icon} size={13} />
						</Button>
					</Tooltip>
				) : null}
				{item.isDefault && active ? (
					<HugeiconsIcon
						aria-hidden="true"
						className="mr-1 text-accent"
						icon={CheckmarkCircle02Icon}
						size={14}
					/>
				) : null}
			</div>
		</div>
	);
}

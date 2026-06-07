import { RadioGroup } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import type { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { useSoundDrop } from "../lib/use-sound-drop";
import { useSoundLibrary } from "../lib/use-sound-library";
import { useSoundPreview } from "../lib/use-sound-preview";
import {
	isActive,
	MAX_CUSTOM_SOUNDS,
	type SoundLibraryItem,
} from "../model/recording-sound";
import { SoundLibraryAddRow } from "./SoundLibraryAddRow";
import { SoundLibraryEmptyState } from "./SoundLibraryEmptyState";
import { SoundLibraryHighlight } from "./SoundLibraryHighlight";
import { SoundLibraryRow } from "./SoundLibraryRow";

type TranslatorFn = ReturnType<typeof useTranslations>;

interface SoundLibraryProps {
	t: TranslatorFn;
	tCommon: TranslatorFn;
}

export function SoundLibrary({ t, tCommon }: SoundLibraryProps): ReactNode {
	const defaultName = t("soundLibraryDefaultName");
	const [bannerError, setBannerError] = useState<string>("");
	const [pendingDelete, setPendingDelete] = useState<SoundLibraryItem | null>(
		null,
	);
	const listRef = useRef<HTMLDivElement | null>(null);

	const limitText = t("soundLibraryLimitReached", { max: MAX_CUSTOM_SOUNDS });
	const library = useSoundLibrary({
		defaultName,
		limitMessage: limitText,
		onError: (msg) => setBannerError(msg),
	});

	const preview = useSoundPreview();

	const drop = useSoundDrop({
		onAdd: (sourcePath, displayName) =>
			library.addFromPath(sourcePath, displayName),
		t,
	});

	const handleAdd = async (): Promise<void> => {
		setBannerError("");
		drop.resetError();
		await library.addFromBrowse();
	};

	const handleSelect = (item: SoundLibraryItem): void => {
		setBannerError("");
		library.select(item);
	};

	const customs = library.items.filter((it) => !it.isDefault);
	const hasCustoms = customs.length > 0;

	// Drive the gliding selected pill: which row id is active, and a key that
	// re-arms its observers when the row set changes.
	const selectedId =
		library.items.find((it) => isActive(it, library.activePath))?.id ?? "";
	const rowsKey = library.items.map((it) => it.id).join("|");

	// Drag feedback stays grayscale — the whole card edge brightens to a neutral
	// ring; no accent, no dashed drop zone.
	const containerClass = cn(
		"transition-[box-shadow] duration-200 ease-out",
		drop.dragOver ? "ring-foreground/30" : "",
	);

	return (
		<div className="flex flex-col gap-2">
			<ElevatedSurface className={containerClass}>
				{/* Drop target wraps both the scrollable list and the pinned add row so
            a file dropped anywhere on the card is accepted. */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: drop target surface — interactive controls live in child rows. */}
				{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: drop target surface — interactive controls live in child rows. */}
				<div
					className="flex flex-col"
					onDragLeave={drop.handlers.onDragLeave}
					onDragOver={drop.handlers.onDragOver}
					onDrop={drop.handlers.onDrop}
				>
					{/* The row list grows with the library only up to ~6.5 rows (the half
              row peeking past the cap is the scroll affordance), then scrolls —
              the section never expands unbounded as sounds are added (capped at
              MAX_CUSTOM_SOUNDS). The selected-pill highlight tracks scroll
              because its geometry is measured in container content space. */}
					<RadioGroup
						className="relative flex max-h-[19.5rem] flex-col overflow-y-auto"
						name="sound-library-row"
						onValueChange={(id) => {
							const item = library.items.find((it) => it.id === id);
							if (item) {
								handleSelect(item);
							}
						}}
						ref={listRef}
						value={selectedId}
					>
						<SoundLibraryHighlight
							containerRef={listRef}
							rowsKey={rowsKey}
							selectedId={selectedId}
						/>
						{library.items.map((item) => (
							<SoundLibraryRow
								active={isActive(item, library.activePath)}
								deleteLabel={t("soundLibraryDelete")}
								isPlaying={preview.playingId === item.id}
								item={item}
								key={item.id}
								labels={{
									play: t("soundLibraryPlay"),
									pause: t("soundLibraryStop"),
								}}
								onDelete={() => setPendingDelete(item)}
								onRename={(it, newName) => library.rename(it.id, newName)}
								onTogglePreview={(it) => preview.toggle(it.id, it.path)}
								renameLabel={t("soundLibraryRename")}
							/>
						))}
					</RadioGroup>
					{hasCustoms ? (
						<SoundLibraryAddRow
							disabled={library.isFull}
							label={t("soundLibraryAddSound")}
							onClick={handleAdd}
						/>
					) : (
						<SoundLibraryEmptyState
							addLabel={t("soundLibraryAddSound")}
							description={t("soundLibraryEmptyDescription")}
							dragOver={drop.dragOver}
							onAdd={handleAdd}
							title={t("soundLibraryEmptyTitle")}
						/>
					)}
				</div>
			</ElevatedSurface>
			{library.isFull ? (
				<p className="text-center text-foreground-muted text-xs-tight">
					{limitText}
				</p>
			) : null}
			{drop.dropError ? (
				<p className="text-center text-error text-xs-tight">{drop.dropError}</p>
			) : null}
			{bannerError && bannerError !== limitText ? (
				<p className="text-center text-error text-xs-tight">{bannerError}</p>
			) : null}
			<ConfirmDialog
				cancelLabel={tCommon("cancel")}
				confirmLabel={tCommon("delete")}
				description={
					pendingDelete
						? t("soundLibraryConfirmDelete", { name: pendingDelete.name })
						: ""
				}
				onConfirm={() => {
					if (pendingDelete) {
						library.remove(pendingDelete);
					}
				}}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
					}
				}}
				open={pendingDelete !== null}
				title={t("soundLibraryConfirmDeleteTitle")}
			/>
		</div>
	);
}

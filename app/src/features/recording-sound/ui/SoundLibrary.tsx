import type { ReactNode } from "react";
import { useRef, useState } from "react";
import type { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { useSoundDrop } from "../lib/use-sound-drop";
import { useSoundLibrary } from "../lib/use-sound-library";
import { useSoundPreview } from "../lib/use-sound-preview";
import { isActive, type SoundLibraryItem } from "../model/recording-sound";
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
	const [pendingDelete, setPendingDelete] = useState<SoundLibraryItem | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	const library = useSoundLibrary({
		defaultName,
		onError: (msg) => setBannerError(msg),
	});

	const preview = useSoundPreview();

	const drop = useSoundDrop({
		onAdd: (sourcePath, displayName) => library.addFromPath(sourcePath, displayName),
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
	const selectedId = library.items.find((it) => isActive(it, library.activePath))?.id ?? "";
	const rowsKey = library.items.map((it) => it.id).join("|");

	// Drag feedback stays grayscale — the whole card edge brightens to a neutral
	// ring; no accent, no dashed drop zone.
	const containerClass = cn(
		"transition-[box-shadow] duration-200 ease-out",
		drop.dragOver ? "ring-foreground/30" : ""
	);

	return (
		<div className="flex flex-col gap-2">
			<ElevatedSurface className={containerClass}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: drop target surface — interactive controls live in child rows. */}
				{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: drop target surface — interactive controls live in child rows. */}
				<div
					className="relative flex flex-col"
					onDragLeave={drop.handlers.onDragLeave}
					onDragOver={drop.handlers.onDragOver}
					onDrop={drop.handlers.onDrop}
					ref={listRef}
				>
					<SoundLibraryHighlight containerRef={listRef} rowsKey={rowsKey} selectedId={selectedId} />
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
							onSelect={handleSelect}
							onTogglePreview={(it) => preview.toggle(it.id, it.path)}
							renameLabel={t("soundLibraryRename")}
						/>
					))}
					{hasCustoms ? (
						<SoundLibraryAddRow label={t("soundLibraryAddSound")} onClick={handleAdd} />
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
			{drop.dropError ? (
				<p className="text-center text-error text-xs-tight">{drop.dropError}</p>
			) : null}
			{bannerError ? <p className="text-center text-error text-xs-tight">{bannerError}</p> : null}
			<ConfirmDialog
				cancelLabel={tCommon("cancel")}
				confirmLabel={tCommon("delete")}
				description={
					pendingDelete ? t("soundLibraryConfirmDelete", { name: pendingDelete.name }) : ""
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

import { SearchIcon, XIcon } from "@/shared/ui/data-grid/primitives/icons";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/shared/ui/data-grid/primitives/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/shared/ui/data-grid/primitives/dialog";
import { useDirection } from "@/shared/ui/data-grid/primitives/direction";
import { Input } from "@/shared/ui/data-grid/primitives/input";
import { Kbd, KbdGroup } from "@/shared/ui/data-grid/primitives/kbd";
import { Separator } from "@/shared/ui/data-grid/primitives/separator";

export interface ShortcutGroup {
	title: string;
	shortcuts: Array<{
		keys: string[];
		description: string;
	}>;
}

interface DataGridKeyboardShortcutsDialogProps {
	open: boolean;
	onOpenChange: (isOpen: boolean) => void;
	input: string;
	onInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
	inputRef: React.RefObject<HTMLInputElement | null>;
	filteredGroups: ShortcutGroup[];
}

export function DataGridKeyboardShortcutsDialog({
	open,
	onOpenChange,
	input,
	onInputChange,
	inputRef,
	filteredGroups,
}: DataGridKeyboardShortcutsDialogProps) {
	const t = useTranslations("dataGrid");
	const dir = useDirection();

	const onOpenAutoFocus = (event: Event) => {
		event.preventDefault();
		inputRef.current?.focus();
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				dir={dir}
				className="max-w-2xl px-0"
				onOpenAutoFocus={onOpenAutoFocus}
				showCloseButton={false}
			>
				<DialogClose className="absolute end-6 top-6" asChild>
					<Button variant="ghost" size="icon" className="size-6">
						<XIcon />
					</Button>
				</DialogClose>
				<DialogHeader className="px-6">
					<DialogTitle>{t("keyboardShortcuts")}</DialogTitle>
					<DialogDescription className="sr-only">
						{t("keyboardShortcutsDescription")}
					</DialogDescription>
				</DialogHeader>
				<div className="px-6">
					<div className="relative">
						<SearchIcon className="absolute start-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							ref={inputRef}
							placeholder="Search shortcuts..."
							className="h-8 ps-8"
							value={input}
							onChange={onInputChange}
						/>
					</div>
				</div>
				<Separator className="mx-auto data-[orientation=horizontal]:w-[calc(100%-(--spacing(12)))]" />
				<div className="h-[40vh] overflow-y-auto px-6">
					{filteredGroups.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center gap-3 text-center">
							<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
								<SearchIcon className="pointer-events-none size-6" />
							</div>
							<div className="flex flex-col gap-1">
								<div className="font-medium text-lg tracking-tight">
									{t("noShortcutsFound")}
								</div>
								<p className="text-muted-foreground text-sm">
									{t("noShortcutsFoundHint")}
								</p>
							</div>
						</div>
					) : (
						<div className="flex flex-col gap-6">
							{filteredGroups.map((shortcutGroup) => (
								<div key={shortcutGroup.title} className="flex flex-col gap-2">
									<h3 className="font-semibold text-foreground text-sm">
										{shortcutGroup.title}
									</h3>
									<div className="divide-y divide-border rounded-md border">
										{shortcutGroup.shortcuts.map((shortcut) => (
											<ShortcutCard
												key={`${shortcut.description}:${shortcut.keys.join("+")}`}
												keys={shortcut.keys}
												description={shortcut.description}
											/>
										))}
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function ShortcutCard({
	keys,
	description,
}: ShortcutGroup["shortcuts"][number]) {
	return (
		<div className="flex items-center gap-4 px-3 py-2">
			<span className="flex-1 text-sm">{description}</span>
			<KbdGroup className="shrink-0">
				{keys.map((key, index) => (
					<React.Fragment key={key}>
						{index > 0 && (
							<span className="text-muted-foreground text-xs">+</span>
						)}
						<Kbd>{key}</Kbd>
					</React.Fragment>
				))}
			</KbdGroup>
		</div>
	);
}

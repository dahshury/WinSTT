import type { TableMeta } from "@tanstack/react-table";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/shared/ui/data-grid/primitives/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/shared/ui/data-grid/primitives/dialog";
import { useAsRef } from "@/shared/ui/data-grid/model/use-as-ref";
import { cn } from "@/shared/lib/cn";
import type { PasteDialogState } from "@/shared/ui/data-grid/types";

interface DataGridPasteDialogProps<TData> {
	tableMeta: TableMeta<TData>;
	pasteDialog: PasteDialogState;
}

export function DataGridPasteDialog<TData>({
	tableMeta,
	pasteDialog,
}: DataGridPasteDialogProps<TData>) {
	const onPasteDialogOpenChange = tableMeta?.onPasteDialogOpenChange;
	const onCellsPaste = tableMeta?.onCellsPaste;

	if (!pasteDialog.open) return null;

	return (
		<PasteDialog
			pasteDialog={pasteDialog}
			onPasteDialogOpenChange={onPasteDialogOpenChange}
			onCellsPaste={onCellsPaste}
		/>
	);
}

interface PasteDialogProps
	extends
		Pick<TableMeta<unknown>, "onPasteDialogOpenChange" | "onCellsPaste">,
		Required<Pick<TableMeta<unknown>, "pasteDialog">> {}

function PasteDialog({
	pasteDialog,
	onPasteDialogOpenChange,
	onCellsPaste,
}: PasteDialogProps) {
	const t = useTranslations("dataGrid");
	const propsRef = useAsRef({
		onPasteDialogOpenChange,
		onCellsPaste,
	});

	const expandRadioRef = React.useRef<HTMLInputElement | null>(null);

	const onOpenChange = (open: boolean) => {
		propsRef.current.onPasteDialogOpenChange?.(open);
	};

	const onCancel = () => {
		propsRef.current.onPasteDialogOpenChange?.(false);
	};

	const onContinue = () => {
		propsRef.current.onCellsPaste?.(expandRadioRef.current?.checked ?? false);
	};

	return (
		<Dialog open={pasteDialog.open} onOpenChange={onOpenChange}>
			<DialogContent data-grid-popover="">
				<DialogHeader>
					<DialogTitle>{t("pasteTitle")}</DialogTitle>
					<DialogDescription>
						{t.rich("pasteNeeded", {
							count: pasteDialog.rowsNeeded,
							strong: (chunks) => <strong>{chunks}</strong>,
						})}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3 py-1">
					<label className="flex cursor-pointer items-start gap-3">
						<RadioItem
							ref={expandRadioRef}
							name="expand-option"
							value="expand"
							defaultChecked
						/>
						<div className="flex flex-col gap-1">
							<span className="font-medium text-sm leading-none">
								{t("createNewRows")}
							</span>
							<span className="text-muted-foreground text-sm">
								{t("createNewRowsDescription", {
									count: pasteDialog.rowsNeeded,
								})}
							</span>
						</div>
					</label>
					<label className="flex cursor-pointer items-start gap-3">
						<RadioItem name="expand-option" value="no-expand" />
						<div className="flex flex-col gap-1">
							<span className="font-medium text-sm leading-none">
								{t("keepCurrentRows")}
							</span>
							<span className="text-muted-foreground text-sm">
								{t("keepCurrentRowsDescription")}
							</span>
						</div>
					</label>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={onCancel}>
						{t("cancel")}
					</Button>
					<Button onClick={onContinue}>{t("continue")}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function RadioItem({ className, ...props }: React.ComponentProps<"input">) {
	return (
		<input
			type="radio"
			className={cn(
				"relative size-4 shrink-0 appearance-none rounded-full border border-input bg-surface-3 shadow-xs outline-none transition-[color,box-shadow]",
				"text-primary focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
				"disabled:cursor-not-allowed disabled:opacity-50",
				"checked:before:absolute checked:before:start-1/2 checked:before:top-1/2 checked:before:size-2 checked:before:-translate-x-1/2 checked:before:-translate-y-1/2 checked:before:rounded-full checked:before:bg-primary checked:before:content-['']",
				className,
			)}
			{...props}
		/>
	);
}

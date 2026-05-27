import { AlertDialog } from "@base-ui/react/alert-dialog";
import { surfaceClasses, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { DialogShell } from "@/shared/ui/dialog-shell";

export interface ConfirmDialogProps {
	cancelLabel?: string;
	confirmLabel?: string;
	description: string;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	title: string;
}

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel = "Delete",
	cancelLabel = "Cancel",
	onConfirm,
}: ConfirmDialogProps) {
	// DialogShell installs a SurfaceProvider at `substrate + 4`. We re-read it
	// here so the cancel button lifts one level above the popup (hover +2).
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 4, 8);
	const buttonLevel = Math.min(popupLevel + 1, 8);
	const buttonHover = Math.min(popupLevel + 2, 8);

	return (
		<DialogShell description={description} onOpenChange={onOpenChange} open={open} title={title}>
			<AlertDialog.Close
				render={
					<Button
						className={`h-8 rounded-md ${surfaceClasses(buttonLevel)} px-4 font-medium text-body text-foreground-secondary transition-colors duration-150 ${surfaceHoverBg(buttonHover)}`}
					>
						{cancelLabel}
					</Button>
				}
			/>
			{/* Wrap the confirm action in AlertDialog.Close so the dialog
			    auto-closes on click via Base UI's `close-press` reason — no
			    manual `onOpenChange(false)` needed. */}
			<AlertDialog.Close
				render={
					<Button
						className="h-8 rounded-md bg-error px-4 font-medium text-body text-white transition-colors duration-150 hover:bg-error-dim"
						onClick={onConfirm}
					>
						{confirmLabel}
					</Button>
				}
			/>
		</DialogShell>
	);
}

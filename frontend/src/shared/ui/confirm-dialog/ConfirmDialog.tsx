import { AlertDialog } from "@base-ui/react/alert-dialog";
import { SurfaceProvider, surfaceClasses, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { dialogAnimation } from "@/shared/ui/dialog-animation";

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
	const handleConfirm = () => {
		onConfirm();
		onOpenChange(false);
	};

	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 4, 8);
	const popupShadow = Math.max(popupLevel, 7);
	const buttonLevel = Math.min(popupLevel + 1, 8);
	const buttonHover = Math.min(popupLevel + 2, 8);

	return (
		<AlertDialog.Root onOpenChange={onOpenChange} open={open}>
			<AlertDialog.Portal>
				<AlertDialog.Backdrop
					className={`${dialogAnimation.backdrop} fixed inset-0 z-confirm-backdrop bg-black/60 backdrop-blur-sm`}
				/>
				<SurfaceProvider value={popupLevel}>
					<AlertDialog.Popup
						className={`${dialogAnimation.popup} fixed top-1/2 left-1/2 z-confirm flex w-[360px] flex-col gap-4 rounded-xl ${surfaceClasses(popupLevel, popupShadow)} p-6 outline-none`}
					>
						<AlertDialog.Title className="m-0 font-sans font-semibold text-[15px] text-foreground">
							{title}
						</AlertDialog.Title>
						<AlertDialog.Description className="m-0 font-sans text-body text-foreground-muted leading-relaxed">
							{description}
						</AlertDialog.Description>
						<div className="mt-1 flex justify-end gap-2">
							<AlertDialog.Close
								render={
									<Button
										className={`h-8 rounded-md ${surfaceClasses(buttonLevel)} px-4 font-medium text-body text-foreground-secondary transition-colors duration-150 ${surfaceHoverBg(buttonHover)}`}
									>
										{cancelLabel}
									</Button>
								}
							/>
							<Button
								className="h-8 rounded-md bg-error px-4 font-medium text-body text-white transition-colors duration-150 hover:bg-error-dim"
								onClick={handleConfirm}
							>
								{confirmLabel}
							</Button>
						</div>
					</AlertDialog.Popup>
				</SurfaceProvider>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}

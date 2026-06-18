export const MODEL_TRIGGER_GLASS_CLASSES = [
	"group relative flex h-auto min-h-[3.25rem] w-full items-center justify-between gap-2 overflow-hidden rounded-lg",
	"bg-gradient-to-b from-surface-3/85 to-surface-2/95 px-3 py-2 text-left",
	"shadow-glass-trigger ring-1 ring-overlay-foreground/[0.07] ring-inset",
	"transition-[transform,background-color,box-shadow] duration-150 ease-out",
	"hover:from-surface-4/85 hover:to-surface-3/95 hover:ring-overlay-foreground/[0.13]",
	"active:scale-[0.99] disabled:cursor-not-allowed",
	"data-[state=open]:from-accent-wash data-[state=open]:to-surface-2/95 data-[state=open]:ring-accent/40",
].join(" ");

import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { useDebouncedCallback } from "@/shared/ui/data-grid/model/use-debounced-callback";
import { ClearableTextField } from "@/shared/ui/text-field";

interface HistorySearchInputProps {
	count: number;
	hasMore: boolean;
	onQueryChange: (query: string) => void;
}

export function HistorySearchInput({
	count,
	hasMore,
	onQueryChange,
}: HistorySearchInputProps) {
	const t = useTranslations("history");
	const [value, setValue] = useState("");
	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const updateQuery = useDebouncedCallback(onQueryChange, 150);

	const openSearch = () => {
		setOpen(true);
		window.requestAnimationFrame(() => inputRef.current?.focus());
	};

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
				event.preventDefault();
				openSearch();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);

	const handleValueChange = (next: string) => {
		setValue(next);
		// Always replace the pending debounced value. Without this, clearing before
		// the 150 ms delay expires can let the previous non-empty query reappear.
		updateQuery(next);
		if (next.length === 0) {
			onQueryChange("");
		}
	};

	return (
		<div
			className={cn(
				"relative h-7 shrink-0 transition-[width] duration-240 ease-[cubic-bezier(0.16,1,0.3,1)]",
				open ? "w-60" : "w-7",
			)}
			data-open={open ? "true" : undefined}
		>
			<Button
				aria-expanded={open}
				aria-label={t("searchPlaceholder")}
				className={cn(
					"absolute inset-0 size-7 rounded-lg text-foreground-muted transition-[background-color,color,opacity,transform] duration-200 hover:bg-foreground/10 hover:text-foreground-secondary active:translate-y-px",
					open && "pointer-events-none scale-90 opacity-0",
				)}
				onClick={openSearch}
			>
				<HugeiconsIcon aria-hidden="true" icon={Search01Icon} size={15} />
			</Button>
			<div
				aria-hidden={open ? undefined : true}
				className={cn(
					"absolute inset-0 transition-[opacity,transform] duration-200",
					open
						? "translate-x-0 opacity-100"
						: "pointer-events-none translate-x-1.5 opacity-0",
				)}
			>
				<ClearableTextField
					aria-label={t("searchPlaceholder")}
					autoFocus={open}
					clearLabel={t("searchClear")}
					className="h-full focus-visible:ring-offset-0"
					leadingIcon={
						<HugeiconsIcon aria-hidden="true" icon={Search01Icon} size={14} />
					}
					key={open ? "search-open" : "search-closed"}
					onBlur={() => {
						if (!value) {
							setOpen(false);
						}
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							handleValueChange("");
							setOpen(false);
							event.currentTarget.blur();
						}
					}}
					onValueChange={handleValueChange}
					placeholder={t("searchPlaceholder")}
					ref={inputRef}
					tabIndex={open ? 0 : -1}
					value={value}
					wrapperClassName="h-full w-full"
				/>
			</div>
			{value.trim() ? (
				<span aria-live="polite" className="sr-only">
					{hasMore
						? t("searchMatchCountMore", { count })
						: t("searchMatchCount", { count })}
				</span>
			) : null}
		</div>
	);
}

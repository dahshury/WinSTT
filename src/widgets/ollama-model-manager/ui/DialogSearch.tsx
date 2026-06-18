import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ClearableTextField } from "@/shared/ui/text-field";
import type { TranslateFn } from "./types";

export function DialogSearch({
	query,
	t,
	onChange,
}: {
	query: string;
	t: TranslateFn;
	onChange: (v: string) => void;
}) {
	return (
		<div className="relative">
			<ClearableTextField
				clearLabel="Clear search"
				leadingIcon={
					<HugeiconsIcon aria-hidden="true" icon={Search01Icon} size={14} />
				}
				onValueChange={onChange}
				placeholder={t("modelSearchPlaceholder")}
				value={query}
			/>
		</div>
	);
}

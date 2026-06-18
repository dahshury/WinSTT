import { FilterIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/DropdownMenu";
import { shouldShowClearAll } from "./parameters-filter-submenu-utils";

interface ClearAllSectionProps {
	onClear: () => void;
	visible: boolean;
}

export function ClearAllSection({ onClear, visible }: ClearAllSectionProps) {
	const t = useTranslations("modelPicker");
	if (!shouldShowClearAll(visible ? 1 : 0)) {
		return null;
	}
	return (
		<>
			<DropdownMenuItem onClick={onClear}>
				<HugeiconsIcon className="me-2 size-4" icon={FilterIcon} />
				<span className="flex-1">{t("clearAll")}</span>
			</DropdownMenuItem>
			<DropdownMenuSeparator />
		</>
	);
}

"use client";

import { LanguageMultiCombobox } from "@/shared/ui/language-multi-combobox";

/**
 * A multi-select filter view (language, precision): the hint plus the shared
 * chip-and-combobox control. Rendering it as its own view is what let the
 * combobox stop competing for space with the rest of the menu — it now gets the
 * full frame, and the root row carries the "3 selected" summary in its place.
 */
export function FilterMultiSelectView({
	ariaLabel,
	emptyLabel,
	hint,
	onChange,
	options,
	placeholder,
	removeLabel,
	selected,
	selectedCountLabel,
	selectedHeading,
}: {
	ariaLabel: string;
	emptyLabel: string;
	hint: string;
	onChange: (next: string[]) => void;
	options: Array<{ badge: string; id: string; label: string }>;
	placeholder: string;
	removeLabel: (value: string) => string;
	selected: string[];
	selectedCountLabel: (count: number) => string;
	selectedHeading: string;
}) {
	return (
		<div className="flex flex-col gap-1.5 p-2 pt-1" data-nav-initial-focus>
			<p className="text-[11px] text-foreground-muted leading-snug">{hint}</p>
			<LanguageMultiCombobox
				ariaLabel={ariaLabel}
				emptyLabel={emptyLabel}
				onChange={onChange}
				options={options}
				placeholder={placeholder}
				removeLabel={removeLabel}
				selectedCountLabel={selectedCountLabel}
				selectedHeading={selectedHeading}
				value={selected}
			/>
		</div>
	);
}

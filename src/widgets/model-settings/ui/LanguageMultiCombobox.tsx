import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceClasses,
	useSurface,
} from "@/shared/lib/surface";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import type { SelectOption } from "@/shared/ui/select";
import "@/shared/ui/searchable-select/searchable-select.css";

export interface LanguageMultiComboboxProps {
	ariaLabel: string;
	disabled?: boolean;
	emptyLabel: string;
	onChange: (value: string[]) => void;
	options: readonly SelectOption[];
	placeholder: string;
	/** Heading shown above the selected-language chips inside the open popup. */
	selectedHeading: string;
	selectedCountLabel: (count: number) => string;
	/** aria-label for a chip's remove button, e.g. "Remove English". */
	removeLabel: (language: string) => string;
	value: readonly string[];
}

function Badge({ text }: { text: string }) {
	return (
		<span className="pointer-events-none inline-flex h-4 min-w-[22px] shrink-0 items-center justify-center rounded-xs border border-border bg-surface-1 px-1 font-mono font-semibold text-[10px] text-foreground-secondary uppercase tracking-wider">
			{text}
		</span>
	);
}

function SelectedChip({
	label,
	onRemove,
	removeLabel,
}: {
	label: string;
	onRemove: () => void;
	removeLabel: (language: string) => string;
}) {
	return (
		<span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-1 py-0.5 pr-0.5 pl-1.5 text-body-sm text-foreground">
			<span className="truncate">{label}</span>
			<button
				aria-label={removeLabel(label)}
				className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim transition-colors hover:bg-error-dim hover:text-error"
				// Keep focus on the combobox input so removing a chip doesn't
				// blur/close the popup; the click still toggles the language off.
				onMouseDown={(event) => event.preventDefault()}
				onClick={onRemove}
				type="button"
			>
				<HugeiconsIcon icon={Cancel01Icon} size={11} />
			</button>
		</span>
	);
}

function optionMatches(option: SelectOption, query: string): boolean {
	const q = query.trim().toLowerCase();
	return (
		q.length === 0 ||
		option.label.toLowerCase().includes(q) ||
		option.id.toLowerCase().includes(q)
	);
}

function summarizeSelection(
	options: readonly SelectOption[],
	value: readonly string[],
	selectedCountLabel: (count: number) => string,
	placeholder: string,
): string {
	if (value.length === 0) {
		return placeholder;
	}
	const labels = value
		.map((id) => options.find((option) => option.id === id)?.label)
		.filter((label): label is string => Boolean(label));
	if (labels.length === 0) {
		return placeholder;
	}
	if (labels.length <= 2) {
		return labels.join(", ");
	}
	return selectedCountLabel(labels.length);
}

export function LanguageMultiCombobox({
	ariaLabel,
	disabled = false,
	emptyLabel,
	onChange,
	options,
	placeholder,
	selectedHeading,
	selectedCountLabel,
	removeLabel,
	value,
}: LanguageMultiComboboxProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const selected = new Set(value);
	const visibleOptions = options.filter((option) =>
		optionMatches(option, query),
	);
	// Selected chips reflect the full selection in selection order, independent
	// of the search query, so the summary always shows every chosen language.
	const selectedOptions = value
		.map((id) => options.find((option) => option.id === id))
		.filter((option): option is SelectOption => Boolean(option));
	const checkedIndices = new Set<number>();
	visibleOptions.forEach((option, index) => {
		if (selected.has(option.id)) {
			checkedIndices.add(index);
		}
	});

	const substrate = useSurface();
	const inputLevel = Math.min(substrate + 1, 8);
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	const popupBg = surfaceBg(popupLevel);
	const closedDisplay = summarizeSelection(
		options,
		value,
		selectedCountLabel,
		placeholder,
	);

	const toggleOption = (id: string): void => {
		const next = selected.has(id)
			? value.filter((candidate) => candidate !== id)
			: [...value, id];
		onChange(next);
	};

	return (
		<Combobox.Root
			disabled={disabled}
			filter={null}
			inputValue={open ? query : closedDisplay}
			items={[]}
			onInputValueChange={setQuery}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setQuery("");
				}
			}}
			open={open}
			value={null}
		>
			<div className="relative isolate flex w-full items-center">
				<Combobox.Input
					aria-label={ariaLabel}
					className={cn(
						`flex h-8 w-full items-center rounded-lg ${surfaceClasses(inputLevel)} pr-7 pl-2.5 font-inherit text-body text-foreground leading-normal outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1`,
						disabled && "cursor-not-allowed opacity-40",
					)}
					onClick={() => {
						if (!disabled) {
							setOpen(true);
						}
					}}
					placeholder={placeholder}
				/>
				<Combobox.Trigger
					aria-label="Open popup"
					className={cn(
						"absolute top-1/2 right-1.5 flex size-5 shrink-0 -translate-y-1/2 items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim",
						disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
					)}
				>
					<HugeiconsIcon icon={ArrowDown01Icon} size={14} />
				</Combobox.Trigger>
			</div>

			<Combobox.Portal>
				<SurfaceProvider value={popupLevel}>
					<Combobox.Positioner
						className="z-popover outline-none"
						collisionPadding={8}
						sideOffset={4}
					>
						<Combobox.Popup
							className={`searchable-select-popup relative w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-sm ${surfaceClasses(popupLevel, popupShadow)} py-1 [max-height:min(16rem,var(--available-height))]`}
						>
							{selectedOptions.length > 0 ? (
								<div
									className={cn(
										"sticky top-0 z-raised mb-1 border-divider border-b px-2 pt-1 pb-2",
										popupBg,
									)}
								>
									<div className="px-0.5 pb-1 font-semibold text-[10px] text-foreground-muted uppercase tracking-wider">
										{selectedHeading}
									</div>
									<div className="flex max-h-[4.5rem] flex-wrap gap-1 overflow-y-auto">
										{selectedOptions.map((option) => (
											<SelectedChip
												key={option.id}
												label={option.label}
												onRemove={() => toggleOption(option.id)}
												removeLabel={removeLabel}
											/>
										))}
									</div>
								</div>
							) : null}
							{visibleOptions.length === 0 ? (
								<div className="px-2.5 py-2 text-body-sm text-foreground-muted">
									{emptyLabel}
								</div>
							) : (
								<CheckboxGroup
									checkedIndices={checkedIndices}
									className="w-full px-1"
								>
									{visibleOptions.map((option, index) => {
										const checked = selected.has(option.id);
										return (
											<CheckboxItem
												checked={checked}
												index={index}
												key={option.id}
												label={option.label}
												leading={
													option.badge ? <Badge text={option.badge} /> : null
												}
												onToggle={() => toggleOption(option.id)}
											/>
										);
									})}
								</CheckboxGroup>
							)}
						</Combobox.Popup>
					</Combobox.Positioner>
				</SurfaceProvider>
			</Combobox.Portal>
		</Combobox.Root>
	);
}

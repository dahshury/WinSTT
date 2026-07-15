import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { ContextAppEntry } from "@/shared/api/ipc-client";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import {
	SurfaceProvider,
	surfaceClasses,
	useSurface,
} from "@/shared/lib/surface";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import "@/shared/ui/searchable-select/searchable-select.css";
import {
	buildContextAppOptions,
	ContextAppIcon,
	normalizeContextAppId,
} from "./context-app-options";

interface ContextAppSingleComboboxProps {
	apps: readonly ContextAppEntry[];
	ariaLabel: string;
	emptyLabel: string;
	onChange: (value: string) => void;
	placeholder?: string;
	value: string;
}

/**
 * Single-value sibling of the Context allow-list picker. It deliberately uses
 * the same app rows, icon treatment, search behavior, surfaces, and popup
 * geometry while keeping the field editable for an executable that is not in
 * the current app snapshot.
 */
export function ContextAppSingleCombobox({
	apps,
	ariaLabel,
	emptyLabel,
	onChange,
	placeholder,
	value,
}: ContextAppSingleComboboxProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const normalizedValue = normalizeContextAppId(value);
	const options = buildContextAppOptions(
		apps,
		normalizedValue ? [normalizedValue] : [],
	);
	const selected = options.find((option) => option.id === normalizedValue);
	const visibleOptions = options.filter((option) =>
		matchesFuzzySearch([option.label, option.exe, option.title ?? ""], query),
	);
	const selectedIndex = visibleOptions.findIndex(
		(option) => option.id === normalizedValue,
	);
	const checkedIndices = new Set<number>(
		selectedIndex >= 0 ? [selectedIndex] : [],
	);
	const substrate = useSurface();
	const inputLevel = Math.min(substrate + 1, 8);
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);

	const close = (): void => {
		setOpen(false);
		setQuery("");
	};

	return (
		<Combobox.Root
			filter={null}
			inputValue={open ? query : (selected?.label ?? normalizedValue)}
			items={[]}
			onInputValueChange={(next) => {
				setQuery(next);
				onChange(next);
			}}
			onOpenChange={(next) => {
				if (next) {
					setOpen(true);
				} else {
					close();
				}
			}}
			open={open}
			value={null}
		>
			<div className="relative isolate flex w-full items-center">
				<Combobox.Input
					aria-label={ariaLabel}
					className={`flex h-8 w-full items-center rounded-lg ${surfaceClasses(inputLevel)} pr-7 pl-2.5 font-inherit text-body text-foreground leading-normal outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1`}
					onClick={() => setOpen(true)}
					placeholder={placeholder}
				/>
				<Combobox.Trigger
					aria-label="Open popup"
					className="absolute top-1/2 right-1.5 flex size-5 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim"
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
							className={`searchable-select-popup relative w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-lg ${surfaceClasses(popupLevel, popupShadow)} py-1 [max-height:min(16rem,var(--available-height))]`}
						>
							{visibleOptions.length === 0 ? (
								<div className="px-2.5 py-2 text-body-sm text-foreground-muted">
									{emptyLabel}
								</div>
							) : (
								<CheckboxGroup
									checkedIndices={checkedIndices}
									className="w-full px-1"
								>
									{visibleOptions.map((option, index) => (
										<CheckboxItem
											checked={option.id === normalizedValue}
											index={index}
											key={option.id}
											label={option.label}
											leading={
												<ContextAppIcon
													icon={option.icon ?? null}
													label={option.label}
												/>
											}
											onToggle={() => {
												onChange(option.exe);
												close();
											}}
											trailing={
												<span className="max-w-[8rem] truncate font-mono text-[11px] text-foreground-muted">
													{option.exe}
												</span>
											}
										/>
									))}
								</CheckboxGroup>
							)}
						</Combobox.Popup>
					</Combobox.Positioner>
				</SurfaceProvider>
			</Combobox.Portal>
		</Combobox.Root>
	);
}

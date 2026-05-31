import { Combobox } from "@base-ui/react/combobox";
import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceClasses,
	surfaceHighlightedBg,
	useSurface,
} from "@/shared/lib/surface";
import "./tag-input.css";

/**
 * A free-form "tags" input: a Base UI multi-select combobox whose selected
 * values ARE the list. There is no fixed catalog — the user types a value and
 * commits it inline (Enter or click on the "create" row), and each existing
 * value is rendered as a removable chip.
 *
 * Implementation notes that make the creatable pattern behave:
 *
 *  - `filter={null}` disables Base UI's built-in input→item matching. The
 *    popup's only row is a single synthesized "create" entry that we build
 *    from the *normalized* candidate, so a normalizer that trims / lower-cases
 *    must not cause Base UI to filter the row out for diverging from the raw
 *    keystrokes.
 *  - `autoHighlight` keeps that lone row highlighted once the user types, so
 *    pressing Enter commits the typed value.
 *  - The `Combobox.Portal` is mounted only while a creatable candidate exists.
 *    The popup has nothing else to show (no catalog), so this keeps an empty
 *    bordered sliver from flashing on focus while letting Base UI own the
 *    open/close/blur lifecycle normally.
 *
 * Selection in `multiple` mode toggles a value, so a single `onValueChange`
 * handles both directions: committing the create row appends the candidate,
 * and a chip's remove button drops its value.
 */
interface TagInputProps {
	/** Label for the synthesized "create" row. Defaults to `Add "<candidate>"`. */
	createLabel?: (candidate: string) => ReactNode;
	disabled?: boolean;
	/** Accessible name for the text input (chips carry their own labels). */
	inputAriaLabel?: string;
	/**
	 * Canonical form a raw keystroke string is stored as — also what
	 * duplicate detection compares against. Defaults to a plain trim.
	 */
	normalize?: (raw: string) => string;
	onChange: (next: string[]) => void;
	placeholder?: string;
	/** aria-label for a chip's remove button. Defaults to `"Remove"`. */
	removeAriaLabel?: (tag: string) => string;
	value: readonly string[];
}

const trimNormalize = (raw: string): string => raw.trim();
const identityLabel = (item: string): string => item;
const defaultCreateLabel = (candidate: string): string => `Add "${candidate}"`;
const defaultRemoveLabel = (): string => "Remove";

export function TagInput({
	disabled = false,
	inputAriaLabel,
	normalize = trimNormalize,
	onChange,
	placeholder,
	removeAriaLabel = defaultRemoveLabel,
	createLabel = defaultCreateLabel,
	value,
}: TagInputProps) {
	const [inputValue, setInputValue] = useState("");

	const substrate = useSurface();
	const inputLevel = Math.min(substrate + 1, 8);
	const chipLevel = Math.min(substrate + 2, 8);
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	const highlightLevel = Math.min(popupLevel + 1, 8);

	const candidate = normalize(inputValue);
	const canCreate = candidate.length > 0 && !value.includes(candidate);
	const items = canCreate ? [candidate] : [];

	return (
		<Combobox.Root
			autoHighlight
			disabled={disabled}
			filter={null}
			inputValue={inputValue}
			items={items}
			itemToStringLabel={identityLabel}
			multiple
			onInputValueChange={setInputValue}
			onValueChange={onChange}
			value={[...value]}
		>
			<Combobox.InputGroup
				className={`flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-sm ${surfaceClasses(inputLevel)} px-2 py-1 focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-1 focus-within:ring-offset-surface-1 ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
			>
				<Combobox.Chips className="flex w-full flex-wrap items-center gap-1">
					<Combobox.Value>
						{(selected: string[]) => (
							<>
								{selected.map((tag) => (
									<Combobox.Chip
										aria-label={tag}
										className={`group flex min-h-6 cursor-default items-center gap-1 rounded-xs border border-border ${surfaceBg(chipLevel)} py-0 ps-2 pe-1 text-foreground`}
										key={tag}
									>
										<span className="max-w-[16rem] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] leading-none">
											{tag}
										</span>
										<Combobox.ChipRemove
											aria-label={removeAriaLabel(tag)}
											className="flex size-4 shrink-0 items-center justify-center rounded-xs border-0 bg-transparent p-0 text-foreground-dim transition-colors duration-150 hover:bg-error-dim hover:text-error"
										>
											<HugeiconsIcon icon={Cancel01Icon} size={12} />
										</Combobox.ChipRemove>
									</Combobox.Chip>
								))}
								<Combobox.Input
									aria-label={inputAriaLabel}
									className="h-6 min-w-28 flex-1 border-0 bg-transparent p-0 ps-1 font-inherit text-body text-foreground leading-normal outline-none placeholder:text-foreground-muted"
									placeholder={selected.length > 0 ? "" : placeholder}
								/>
							</>
						)}
					</Combobox.Value>
				</Combobox.Chips>
			</Combobox.InputGroup>

			{canCreate ? (
				<Combobox.Portal>
					<SurfaceProvider value={popupLevel}>
						<Combobox.Positioner
							className="z-popover outline-none"
							collisionPadding={8}
							sideOffset={4}
						>
							<Combobox.Popup
								className={`tag-input-popup w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-sm ${surfaceClasses(popupLevel, popupShadow)} py-1 [max-height:min(12rem,var(--available-height))]`}
							>
								<Combobox.List className="outline-none">
									{(item: string) => (
										<Combobox.Item
											className={`tag-input-item mx-1 flex cursor-default select-none items-center gap-1.5 rounded-xs px-2.5 py-[7px] text-body text-foreground leading-normal outline-none ${surfaceHighlightedBg(highlightLevel)}`}
											key={item}
											value={item}
										>
											<HugeiconsIcon
												aria-hidden="true"
												className="shrink-0 text-foreground-muted"
												icon={PlusSignIcon}
												size={14}
											/>
											<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
												{createLabel(item)}
											</span>
										</Combobox.Item>
									)}
								</Combobox.List>
							</Combobox.Popup>
						</Combobox.Positioner>
					</SurfaceProvider>
				</Combobox.Portal>
			) : null}
		</Combobox.Root>
	);
}

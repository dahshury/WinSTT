import { Check, Upload, X } from "@/shared/ui/data-grid/primitives/icons";
import * as React from "react";
import { useTranslations } from "use-intl";
import { toast } from "@/shared/ui/data-grid/primitives/toast";
import { DataGridCellWrapper } from "@/shared/ui/data-grid/data-grid-cell-wrapper";
import { Badge } from "@/shared/ui/data-grid/primitives/badge";
import { Button } from "@/shared/ui/data-grid/primitives/button";
import { Calendar } from "@/shared/ui/data-grid/primitives/calendar";
import { Checkbox } from "@/shared/ui/data-grid/primitives/checkbox";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/shared/ui/data-grid/primitives/command";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/shared/ui/data-grid/primitives/popover";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/shared/ui/data-grid/primitives/select";
import { Skeleton } from "@/shared/ui/data-grid/primitives/skeleton";
import { Textarea } from "@/shared/ui/data-grid/primitives/textarea";
import { useBadgeOverflow } from "@/shared/ui/data-grid/model/use-badge-overflow";
import { useDebouncedCallback } from "@/shared/ui/data-grid/model/use-debounced-callback";
import {
	formatDateForDisplay,
	formatDateToString,
	formatFileSize,
	getCellKey,
	getFileIcon,
	getLineCount,
	getUrlHref,
	parseLocalDate,
} from "@/shared/ui/data-grid/lib/data-grid";
import { cn } from "@/shared/lib/cn";
import type {
	DataGridCellProps,
	FileCellData,
} from "@/shared/ui/data-grid/types";

function stopMouseEventPropagation(event: React.MouseEvent) {
	event.stopPropagation();
}

function preventAndStopDragEvent(event: React.DragEvent) {
	event.preventDefault();
	event.stopPropagation();
}

const onEditorEscapeKeyDown: NonNullable<
	React.ComponentProps<typeof PopoverContent>["onEscapeKeyDown"]
> = (event) => {
	// Prevent the escape key from propagating to the data grid's keyboard handler
	// which would call blurCell() and remove focus from the cell
	event.stopPropagation();
};

export function ShortTextCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	state,
}: DataGridCellProps<TData>) {
	const { isEditing, isFocused, readOnly } = state;
	const initialValue = cell.getValue() as string;
	const [value, setValue] = React.useState(initialValue);
	const cellRef = React.useRef<HTMLDivElement>(null);
	const containerRef = React.useRef<HTMLDivElement>(null);
	const prevIsEditingRef = React.useRef(false);

	const prevInitialValueRef = React.useRef(initialValue);
	// eslint-disable-next-line react-hooks-js/refs -- prev-prop compare-and-set: the condition reads the ref during render to derive cell state when the value prop changes (canonical React derive-on-prop-change idiom)
	if (initialValue !== prevInitialValueRef.current) {
		// eslint-disable-next-line react-hooks-js/refs -- valid prev-prop compare-and-set to derive state on prop change
		prevInitialValueRef.current = initialValue;
		setValue(initialValue);
		// eslint-disable-next-line react-hooks-js/refs -- entangled contentEditable DOM sync during prop-change derivation; rewriting risks cursor/focus regressions
		if (cellRef.current && !isEditing) {
			// eslint-disable-next-line react-hooks-js/refs -- entangled contentEditable DOM sync during prop-change derivation; rewriting risks cursor/focus regressions
			cellRef.current.textContent = initialValue;
		}
	}

	const onBlur = () => {
		// Read the current value directly from the DOM to avoid stale state
		const currentValue = cellRef.current?.textContent ?? "";
		if (!readOnly && currentValue !== initialValue) {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: currentValue });
		}
		tableMeta?.onCellEditingStop?.();
	};

	const onInput = (event: React.FormEvent<HTMLDivElement>) => {
		const currentValue = event.currentTarget.textContent ?? "";
		setValue(currentValue);
	};

	const onWrapperKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		{
			if (isEditing) {
				if (event.key === "Enter") {
					event.preventDefault();
					const currentValue = cellRef.current?.textContent ?? "";
					if (currentValue !== initialValue) {
						tableMeta?.onDataUpdate?.({
							rowIndex,
							columnId,
							value: currentValue,
						});
					}
					tableMeta?.onCellEditingStop?.({ moveToNextRow: true });
				} else if (event.key === "Tab") {
					event.preventDefault();
					const currentValue = cellRef.current?.textContent ?? "";
					if (currentValue !== initialValue) {
						tableMeta?.onDataUpdate?.({
							rowIndex,
							columnId,
							value: currentValue,
						});
					}
					tableMeta?.onCellEditingStop?.({
						direction: event.shiftKey ? "left" : "right",
					});
				} else if (event.key === "Escape") {
					event.preventDefault();
					setValue(initialValue);
					cellRef.current?.blur();
				}
			} else if (
				isFocused &&
				event.key.length === 1 &&
				!event.ctrlKey &&
				!event.metaKey
			) {
				// Handle typing to pre-fill the value when editing starts
				setValue(event.key);

				queueMicrotask(() => {
					if (cellRef.current && cellRef.current.contentEditable === "true") {
						cellRef.current.textContent = event.key;
						const range = document.createRange();
						const selection = window.getSelection();
						range.selectNodeContents(cellRef.current);
						range.collapse(false);
						selection?.removeAllRanges();
						selection?.addRange(range);
					}
				});
			}
		}
	};

	React.useEffect(() => {
		const wasEditing = prevIsEditingRef.current;
		prevIsEditingRef.current = isEditing;

		if (isEditing && !wasEditing && cellRef.current) {
			cellRef.current.focus();

			if (!cellRef.current.textContent && value) {
				cellRef.current.textContent = value;
			}

			if (cellRef.current.textContent) {
				const range = document.createRange();
				const selection = window.getSelection();
				range.selectNodeContents(cellRef.current);
				range.collapse(false);
				selection?.removeAllRanges();
				selection?.addRange(range);
			}
		}
	}, [isEditing, value]);

	const displayValue = !isEditing ? (value ?? "") : "";

	return (
		<DataGridCellWrapper<TData>
			ref={containerRef}
			cell={cell}
			tableMeta={tableMeta}
			rowIndex={rowIndex}
			columnId={columnId}
			rowHeight={rowHeight}
			state={state}
			onKeyDown={onWrapperKeyDown}
		>
			<div
				// eslint-disable-next-line react-doctor/prefer-tag-over-role -- contentEditable div cannot be an <input>; role=textbox is correct
				role="textbox"
				data-slot="grid-cell-content"
				contentEditable={isEditing}
				tabIndex={-1}
				ref={cellRef}
				onBlur={onBlur}
				onInput={onInput}
				suppressContentEditableWarning
				className={cn("size-full overflow-hidden outline-none", {
					"whitespace-nowrap **:inline **:whitespace-nowrap [&_br]:hidden":
						isEditing,
				})}
			>
				{displayValue}
			</div>
		</DataGridCellWrapper>
	);
}

export function LongTextCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	state,
}: DataGridCellProps<TData>) {
	const { isEditing, isFocused, readOnly } = state;
	const initialValue = cell.getValue() as string;
	const [value, setValue] = React.useState(initialValue ?? "");
	const textareaRef = React.useRef<HTMLTextAreaElement>(null);
	const containerRef = React.useRef<HTMLDivElement>(null);
	const pendingCharRef = React.useRef<string | null>(null);
	// eslint-disable-next-line react-hooks-js/refs -- popover offset is derived from a live DOM measurement; reading during render preserves existing positioning behavior
	const sideOffset = -(containerRef.current?.clientHeight ?? 0);

	const prevInitialValueRef = React.useRef(initialValue);
	// eslint-disable-next-line react-hooks-js/refs -- prev-prop compare-and-set: the condition reads the ref during render to derive cell state when the value prop changes (canonical React derive-on-prop-change idiom)
	if (initialValue !== prevInitialValueRef.current) {
		// eslint-disable-next-line react-hooks-js/refs -- valid prev-prop compare-and-set to derive state on prop change
		prevInitialValueRef.current = initialValue;
		setValue(initialValue ?? "");
	}

	const debouncedSave = useDebouncedCallback((newValue: string) => {
		if (!readOnly) {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValue });
		}
	}, 300);

	const onSave = () => {
		// Immediately save any pending changes and close the popover
		if (!readOnly && value !== initialValue) {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value });
		}
		tableMeta?.onCellEditingStop?.();
	};

	const onCancel = () => {
		// Restore the original value
		setValue(initialValue ?? "");
		if (!readOnly) {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: initialValue });
		}
		tableMeta?.onCellEditingStop?.();
	};

	const onOpenChange = (open: boolean) => {
		if (open && !readOnly) {
			tableMeta?.onCellEditingStart?.(rowIndex, columnId);
		} else {
			// Immediately save any pending changes when closing
			if (!readOnly && value !== initialValue) {
				tableMeta?.onDataUpdate?.({ rowIndex, columnId, value });
			}
			tableMeta?.onCellEditingStop?.();
		}
	};

	const onOpenAutoFocus: NonNullable<
		React.ComponentProps<typeof PopoverContent>["onOpenAutoFocus"]
	> = (event) => {
		event.preventDefault();
		if (textareaRef.current) {
			textareaRef.current.focus();
			const length = textareaRef.current.value.length;
			textareaRef.current.setSelectionRange(length, length);

			// Insert pending character using execCommand so it's part of undo history
			// Use requestAnimationFrame to ensure focus has fully settled
			if (pendingCharRef.current) {
				const char = pendingCharRef.current;
				pendingCharRef.current = null;
				requestAnimationFrame(() => {
					if (
						textareaRef.current &&
						document.activeElement === textareaRef.current
					) {
						document.execCommand("insertText", false, char);
						textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
					}
				});
			} else {
				textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
			}
		}
	};

	const onWrapperKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (
			isFocused &&
			!isEditing &&
			!readOnly &&
			event.key.length === 1 &&
			!event.ctrlKey &&
			!event.metaKey
		) {
			// Store the character to be inserted after textarea focuses
			// This ensures it's part of the textarea's undo history
			pendingCharRef.current = event.key;
		}
	};

	const onBlur = () => {
		// Immediately save any pending changes on blur
		if (!readOnly && value !== initialValue) {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value });
		}
		tableMeta?.onCellEditingStop?.();
	};

	const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
		const newValue = event.target.value;
		setValue(newValue);
		debouncedSave(newValue);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		{
			if (event.key === "Escape") {
				event.preventDefault();
				onCancel();
			} else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				onSave();
			} else if (event.key === "Tab") {
				event.preventDefault();
				// Save any pending changes
				if (value !== initialValue) {
					tableMeta?.onDataUpdate?.({ rowIndex, columnId, value });
				}
				tableMeta?.onCellEditingStop?.({
					direction: event.shiftKey ? "left" : "right",
				});
				return;
			}
			// Stop propagation to prevent grid navigation
			event.stopPropagation();
		}
	};

	return (
		<Popover open={isEditing} onOpenChange={onOpenChange}>
			<PopoverAnchor asChild>
				<DataGridCellWrapper<TData>
					ref={containerRef}
					cell={cell}
					tableMeta={tableMeta}
					rowIndex={rowIndex}
					columnId={columnId}
					rowHeight={rowHeight}
					state={state}
					onKeyDown={onWrapperKeyDown}
				>
					<span data-slot="grid-cell-content">{value}</span>
				</DataGridCellWrapper>
			</PopoverAnchor>
			<PopoverContent
				data-grid-cell-editor=""
				align="start"
				side="bottom"
				sideOffset={sideOffset}
				className="w-[400px] rounded-none p-0"
				onOpenAutoFocus={onOpenAutoFocus}
			>
				<Textarea
					placeholder="Enter text..."
					className="max-h-[300px] min-h-[150px] resize-none overflow-y-auto rounded-none border-0 shadow-none focus-visible:ring-1 focus-visible:ring-ring"
					ref={textareaRef}
					value={value}
					onBlur={onBlur}
					onChange={onChange}
					onKeyDown={onKeyDown}
				/>
			</PopoverContent>
		</Popover>
	);
}

export function NumberCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	state,
}: DataGridCellProps<TData>) {
	const { isEditing, isFocused, readOnly } = state;
	const initialValue = cell.getValue() as number;
	const [value, setValue] = React.useState(String(initialValue ?? ""));
	const inputRef = React.useRef<HTMLInputElement>(null);
	const containerRef = React.useRef<HTMLDivElement>(null);

	const cellOpts = cell.column.columnDef.meta?.cell;
	const numberCellOpts = cellOpts?.variant === "number" ? cellOpts : null;
	const min = numberCellOpts?.min;
	const max = numberCellOpts?.max;
	const step = numberCellOpts?.step;

	const prevIsEditingRef = React.useRef(false);

	const prevInitialValueRef = React.useRef(initialValue);
	// eslint-disable-next-line react-hooks-js/refs -- prev-prop compare-and-set: the condition reads the ref during render to derive cell state when the value prop changes (canonical React derive-on-prop-change idiom)
	if (initialValue !== prevInitialValueRef.current) {
		// eslint-disable-next-line react-hooks-js/refs -- valid prev-prop compare-and-set to derive state on prop change
		prevInitialValueRef.current = initialValue;
		setValue(String(initialValue ?? ""));
	}

	const onBlur = () => {
		const numValue = value === "" ? null : Number(value);
		if (!readOnly && numValue !== initialValue) {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: numValue });
		}
		tableMeta?.onCellEditingStop?.();
	};

	const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		setValue(event.target.value);
	};

	const onWrapperKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		{
			if (isEditing) {
				if (event.key === "Enter") {
					event.preventDefault();
					const numValue = value === "" ? null : Number(value);
					if (numValue !== initialValue) {
						tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: numValue });
					}
					tableMeta?.onCellEditingStop?.({ moveToNextRow: true });
				} else if (event.key === "Tab") {
					event.preventDefault();
					const numValue = value === "" ? null : Number(value);
					if (numValue !== initialValue) {
						tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: numValue });
					}
					tableMeta?.onCellEditingStop?.({
						direction: event.shiftKey ? "left" : "right",
					});
				} else if (event.key === "Escape") {
					event.preventDefault();
					setValue(String(initialValue ?? ""));
					inputRef.current?.blur();
				}
			} else if (isFocused) {
				// Handle Backspace to start editing with empty value
				if (event.key === "Backspace") {
					setValue("");
				} else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
					// Handle typing to pre-fill the value when editing starts
					setValue(event.key);
				}
			}
		}
	};

	React.useEffect(() => {
		const wasEditing = prevIsEditingRef.current;
		prevIsEditingRef.current = isEditing;

		// Only focus when we start editing (transition from false to true)
		if (isEditing && !wasEditing && inputRef.current) {
			inputRef.current.focus();
		}
	}, [isEditing]);

	return (
		<DataGridCellWrapper<TData>
			ref={containerRef}
			cell={cell}
			tableMeta={tableMeta}
			rowIndex={rowIndex}
			columnId={columnId}
			rowHeight={rowHeight}
			state={state}
			onKeyDown={onWrapperKeyDown}
		>
			{isEditing ? (
				<input
					type="number"
					aria-label={String(columnId)}
					ref={inputRef}
					value={value}
					min={min}
					max={max}
					step={step}
					className="w-full border-none bg-transparent p-0 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
					onBlur={onBlur}
					onChange={onChange}
				/>
			) : (
				<span data-slot="grid-cell-content">{value}</span>
			)}
		</DataGridCellWrapper>
	);
}

export function UrlCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	state,
}: DataGridCellProps<TData>) {
	const { isEditing, isFocused, readOnly } = state;
	const initialValue = cell.getValue() as string;
	const [value, setValue] = React.useState(initialValue ?? "");
	const cellRef = React.useRef<HTMLDivElement>(null);
	const containerRef = React.useRef<HTMLDivElement>(null);
	const prevIsEditingRef = React.useRef(false);

	const prevInitialValueRef = React.useRef(initialValue);
	// eslint-disable-next-line react-hooks-js/refs -- prev-prop compare-and-set: the condition reads the ref during render to derive cell state when the value prop changes (canonical React derive-on-prop-change idiom)
	if (initialValue !== prevInitialValueRef.current) {
		// eslint-disable-next-line react-hooks-js/refs -- valid prev-prop compare-and-set to derive state on prop change
		prevInitialValueRef.current = initialValue;
		setValue(initialValue ?? "");
		// eslint-disable-next-line react-hooks-js/refs -- entangled contentEditable DOM sync during prop-change derivation; rewriting risks cursor/focus regressions
		if (cellRef.current && !isEditing) {
			// eslint-disable-next-line react-hooks-js/refs -- entangled contentEditable DOM sync during prop-change derivation; rewriting risks cursor/focus regressions
			cellRef.current.textContent = initialValue ?? "";
		}
	}

	const onBlur = () => {
		const currentValue = cellRef.current?.textContent?.trim() ?? "";

		if (!readOnly && currentValue !== initialValue) {
			tableMeta?.onDataUpdate?.({
				rowIndex,
				columnId,
				value: currentValue || null,
			});
		}
		tableMeta?.onCellEditingStop?.();
	};

	const onInput = (event: React.FormEvent<HTMLDivElement>) => {
		const currentValue = event.currentTarget.textContent ?? "";
		setValue(currentValue);
	};

	const onWrapperKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		{
			if (isEditing) {
				if (event.key === "Enter") {
					event.preventDefault();
					const currentValue = cellRef.current?.textContent?.trim() ?? "";
					if (!readOnly && currentValue !== initialValue) {
						tableMeta?.onDataUpdate?.({
							rowIndex,
							columnId,
							value: currentValue || null,
						});
					}
					tableMeta?.onCellEditingStop?.({ moveToNextRow: true });
				} else if (event.key === "Tab") {
					event.preventDefault();
					const currentValue = cellRef.current?.textContent?.trim() ?? "";
					if (!readOnly && currentValue !== initialValue) {
						tableMeta?.onDataUpdate?.({
							rowIndex,
							columnId,
							value: currentValue || null,
						});
					}
					tableMeta?.onCellEditingStop?.({
						direction: event.shiftKey ? "left" : "right",
					});
				} else if (event.key === "Escape") {
					event.preventDefault();
					setValue(initialValue ?? "");
					cellRef.current?.blur();
				}
			} else if (
				isFocused &&
				!readOnly &&
				event.key.length === 1 &&
				!event.ctrlKey &&
				!event.metaKey
			) {
				// Handle typing to pre-fill the value when editing starts
				setValue(event.key);

				queueMicrotask(() => {
					if (cellRef.current && cellRef.current.contentEditable === "true") {
						cellRef.current.textContent = event.key;
						const range = document.createRange();
						const selection = window.getSelection();
						range.selectNodeContents(cellRef.current);
						range.collapse(false);
						selection?.removeAllRanges();
						selection?.addRange(range);
					}
				});
			}
		}
	};

	const onLinkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
		if (isEditing) {
			event.preventDefault();
			return;
		}

		// Check if URL was rejected due to dangerous protocol
		const href = getUrlHref(value);
		if (!href) {
			event.preventDefault();
			toast.error("Invalid URL", {
				description:
					"URL contains a dangerous protocol (javascript:, data:, vbscript:, or file:)",
			});
			return;
		}

		// Stop propagation to prevent grid from interfering with link navigation
		event.stopPropagation();
	};

	React.useEffect(() => {
		const wasEditing = prevIsEditingRef.current;
		prevIsEditingRef.current = isEditing;

		if (isEditing && !wasEditing && cellRef.current) {
			cellRef.current.focus();

			if (!cellRef.current.textContent && value) {
				cellRef.current.textContent = value;
			}

			if (cellRef.current.textContent) {
				const range = document.createRange();
				const selection = window.getSelection();
				range.selectNodeContents(cellRef.current);
				range.collapse(false);
				selection?.removeAllRanges();
				selection?.addRange(range);
			}
		}
	}, [isEditing, value]);

	const displayValue = !isEditing ? (value ?? "") : "";
	const urlHref = displayValue ? getUrlHref(displayValue) : "";
	const isDangerousUrl = displayValue && !urlHref;

	return (
		<DataGridCellWrapper<TData>
			ref={containerRef}
			cell={cell}
			tableMeta={tableMeta}
			rowIndex={rowIndex}
			columnId={columnId}
			rowHeight={rowHeight}
			state={state}
			onKeyDown={onWrapperKeyDown}
		>
			{!isEditing && displayValue ? (
				<div
					data-slot="grid-cell-content"
					className="size-full overflow-hidden"
				>
					<a
						data-focused={isFocused && !isDangerousUrl ? "" : undefined}
						data-invalid={isDangerousUrl ? "" : undefined}
						href={urlHref}
						target="_blank"
						rel="noopener noreferrer"
						className="truncate text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary/60 data-invalid:cursor-not-allowed data-focused:text-foreground data-invalid:text-destructive data-focused:decoration-foreground/50 data-invalid:decoration-destructive/50 data-focused:hover:decoration-foreground/70 data-invalid:hover:decoration-destructive/70"
						onClick={onLinkClick}
					>
						{displayValue}
					</a>
				</div>
			) : (
				<div
					// eslint-disable-next-line react-doctor/prefer-tag-over-role -- contentEditable div cannot be an <input>; role=textbox is correct
					role="textbox"
					data-slot="grid-cell-content"
					contentEditable={isEditing}
					tabIndex={-1}
					ref={cellRef}
					onBlur={onBlur}
					onInput={onInput}
					suppressContentEditableWarning
					className={cn("size-full overflow-hidden outline-none", {
						"whitespace-nowrap **:inline **:whitespace-nowrap [&_br]:hidden":
							isEditing,
					})}
				>
					{displayValue}
				</div>
			)}
		</DataGridCellWrapper>
	);
}

export function CheckboxCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	state,
}: DataGridCellProps<TData>) {
	const { isFocused, readOnly } = state;
	const initialValue = cell.getValue() as boolean;
	const [value, setValue] = React.useState(Boolean(initialValue));
	const containerRef = React.useRef<HTMLDivElement>(null);

	const prevInitialValueRef = React.useRef(initialValue);
	// eslint-disable-next-line react-hooks-js/refs -- prev-prop compare-and-set: the condition reads the ref during render to derive cell state when the value prop changes (canonical React derive-on-prop-change idiom)
	if (initialValue !== prevInitialValueRef.current) {
		// eslint-disable-next-line react-hooks-js/refs -- valid prev-prop compare-and-set to derive state on prop change
		prevInitialValueRef.current = initialValue;
		setValue(Boolean(initialValue));
	}

	const onCheckedChange = (checked: boolean) => {
		if (readOnly) return;
		setValue(checked);
		tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: checked });
	};

	const onWrapperKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (
			isFocused &&
			!readOnly &&
			(event.key === " " || event.key === "Enter")
		) {
			event.preventDefault();
			event.stopPropagation();
			onCheckedChange(!value);
		} else if (isFocused && event.key === "Tab") {
			event.preventDefault();
			tableMeta?.onCellEditingStop?.({
				direction: event.shiftKey ? "left" : "right",
			});
		}
	};

	const onWrapperClick = (event: React.MouseEvent) => {
		if (isFocused && !readOnly) {
			event.preventDefault();
			event.stopPropagation();
			onCheckedChange(!value);
		}
	};

	return (
		<DataGridCellWrapper<TData>
			ref={containerRef}
			cell={cell}
			tableMeta={tableMeta}
			rowIndex={rowIndex}
			columnId={columnId}
			rowHeight={rowHeight}
			state={{ ...state, isEditing: false }}
			className="flex size-full justify-center"
			onClick={onWrapperClick}
			onKeyDown={onWrapperKeyDown}
		>
			<Checkbox
				checked={value}
				onCheckedChange={onCheckedChange}
				disabled={readOnly}
				className="border-primary"
				onClick={stopMouseEventPropagation}
				onMouseDown={stopMouseEventPropagation}
				onDoubleClick={stopMouseEventPropagation}
			/>
		</DataGridCellWrapper>
	);
}

export function SelectCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	state,
}: DataGridCellProps<TData>) {
	const { isEditing, isFocused, readOnly } = state;
	const initialValue = (cell.getValue() ?? undefined) as string | undefined;

	const [value, setValue] = React.useState(initialValue);
	const containerRef = React.useRef<HTMLDivElement>(null);
	const cellOpts = cell.column.columnDef.meta?.cell;
	const options = cellOpts?.variant === "select" ? cellOpts.options : [];
	const optionByValue = new Map(
		options.map((option) => [option.value, option]),
	);

	const prevInitialValueRef = React.useRef(initialValue);
	// eslint-disable-next-line react-hooks-js/refs -- prev-prop compare-and-set: the condition reads the ref during render to derive cell state when the value prop changes (canonical React derive-on-prop-change idiom)
	if (initialValue !== prevInitialValueRef.current) {
		// eslint-disable-next-line react-hooks-js/refs -- valid prev-prop compare-and-set to derive state on prop change
		prevInitialValueRef.current = initialValue;
		setValue(initialValue);
	}

	const onValueChange = (newValue: string) => {
		if (readOnly) return;
		setValue(newValue);
		tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValue });
		tableMeta?.onCellEditingStop?.();
	};

	const onOpenChange = (open: boolean) => {
		if (open && !readOnly) {
			tableMeta?.onCellEditingStart?.(rowIndex, columnId);
		} else {
			tableMeta?.onCellEditingStop?.();
		}
	};

	const onWrapperKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (isEditing && event.key === "Escape") {
			event.preventDefault();
			setValue(initialValue);
			tableMeta?.onCellEditingStop?.();
		} else if (isFocused && event.key === "Tab") {
			event.preventDefault();
			tableMeta?.onCellEditingStop?.({
				direction: event.shiftKey ? "left" : "right",
			});
		}
	};

	const displayLabel = value
		? (optionByValue.get(value)?.label ?? value)
		: null;

	return (
		<DataGridCellWrapper<TData>
			ref={containerRef}
			cell={cell}
			tableMeta={tableMeta}
			rowIndex={rowIndex}
			columnId={columnId}
			rowHeight={rowHeight}
			state={state}
			onKeyDown={onWrapperKeyDown}
		>
			{isEditing ? (
				<Select
					value={value}
					onValueChange={onValueChange}
					open={isEditing}
					onOpenChange={onOpenChange}
				>
					<SelectTrigger className="size-full items-start border-none bg-transparent p-0 shadow-none focus-visible:ring-0 [&_svg]:hidden">
						{displayLabel ? (
							<Badge
								variant="secondary"
								className="whitespace-pre-wrap px-1.5 py-px"
							>
								<SelectValue />
							</Badge>
						) : (
							<SelectValue />
						)}
					</SelectTrigger>
					<SelectContent
						data-grid-cell-editor=""
						// compensate for the wrapper padding
						align="start"
						alignOffset={-8}
						sideOffset={-8}
						className="min-w-[calc(var(--radix-select-trigger-width)+16px)]"
					>
						<SelectGroup>
							{options.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			) : displayLabel ? (
				<Badge
					data-slot="grid-cell-content"
					variant="secondary"
					className="whitespace-pre-wrap px-1.5 py-px"
				>
					{displayLabel}
				</Badge>
			) : null}
		</DataGridCellWrapper>
	);
}

export function MultiSelectCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	state,
}: DataGridCellProps<TData>) {
	const { isEditing, isFocused, readOnly } = state;
	const t = useTranslations("dataGrid");
	const rawCellValue = cell.getValue() as string[];
	const cellValue = rawCellValue ?? [];

	const cellKey = getCellKey(rowIndex, columnId);
	const prevCellKeyRef = React.useRef(cellKey);

	const [selectedValues, setSelectedValues] =
		React.useState<string[]>(cellValue);
	const [searchValue, setSearchValue] = React.useState("");
	const containerRef = React.useRef<HTMLDivElement>(null);
	const inputRef = React.useRef<HTMLInputElement>(null);
	const cellOpts = cell.column.columnDef.meta?.cell;
	const options = cellOpts?.variant === "multi-select" ? cellOpts.options : [];
	const optionByValue = new Map(
		options.map((option) => [option.value, option]),
	);
	// eslint-disable-next-line react-hooks-js/refs -- popover offset is derived from a live DOM measurement; reading during render preserves existing positioning behavior
	const sideOffset = -(containerRef.current?.clientHeight ?? 0);

	const prevCellValueRef = React.useRef(cellValue);
	// eslint-disable-next-line react-hooks-js/refs -- prev-prop compare-and-set: the condition reads the ref during render to derive cell state when the value prop changes (canonical React derive-on-prop-change idiom)
	if (cellValue !== prevCellValueRef.current) {
		// eslint-disable-next-line react-hooks-js/refs -- valid prev-prop compare-and-set to derive state on prop change
		prevCellValueRef.current = cellValue;
		setSelectedValues(cellValue);
	}

	// eslint-disable-next-line react-hooks-js/refs -- valid prev-key compare-and-set to reset state when the cell identity changes
	if (prevCellKeyRef.current !== cellKey) {
		// eslint-disable-next-line react-hooks-js/refs -- valid prev-key compare-and-set to reset state when the cell identity changes
		prevCellKeyRef.current = cellKey;
		setSearchValue("");
	}

	const onValueChange = (value: string) => {
		if (readOnly) return;
		let newValues: string[] = [];
		setSelectedValues((curr) => {
			newValues = curr.includes(value)
				? curr.filter((v) => v !== value)
				: [...curr, value];
			return newValues;
		});
		queueMicrotask(() => {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValues });
			inputRef.current?.focus();
		});
		setSearchValue("");
	};

	const removeValue = (valueToRemove: string, event?: React.MouseEvent) => {
		if (readOnly) return;
		event?.stopPropagation();
		event?.preventDefault();
		let newValues: string[] = [];
		setSelectedValues((curr) => {
			newValues = curr.filter((v) => v !== valueToRemove);
			return newValues;
		});
		queueMicrotask(() => {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValues });
			inputRef.current?.focus();
		});
	};

	const clearAll = () => {
		if (readOnly) return;
		setSelectedValues([]);
		tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: [] });
		queueMicrotask(() => inputRef.current?.focus());
	};

	const onOpenChange = (open: boolean) => {
		if (open && !readOnly) {
			tableMeta?.onCellEditingStart?.(rowIndex, columnId);
		} else {
			setSearchValue("");
			tableMeta?.onCellEditingStop?.();
		}
	};

	const onOpenAutoFocus: NonNullable<
		React.ComponentProps<typeof PopoverContent>["onOpenAutoFocus"]
	> = (event) => {
		event.preventDefault();
		inputRef.current?.focus();
	};

	const onWrapperKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (isEditing && event.key === "Escape") {
			event.preventDefault();
			setSelectedValues(cellValue);
			setSearchValue("");
			tableMeta?.onCellEditingStop?.();
		} else if (isFocused && event.key === "Tab") {
			event.preventDefault();
			setSearchValue("");
			tableMeta?.onCellEditingStop?.({
				direction: event.shiftKey ? "left" : "right",
			});
		}
	};

	const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Backspace" && searchValue === "") {
			event.preventDefault();
			let newValues: string[] | null = null;
			setSelectedValues((curr) => {
				if (curr.length === 0) return curr;
				newValues = curr.slice(0, -1);
				return newValues;
			});
			queueMicrotask(() => {
				if (newValues !== null) {
					tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValues });
				}
				inputRef.current?.focus();
			});
		}
		if (event.key === "Escape") {
			event.stopPropagation();
		}
	};

	const displayLabels = selectedValues.flatMap((val) => {
		const label = optionByValue.get(val)?.label ?? val;
		return label ? [label] : [];
	});

	const selectedValuesSet = new Set(selectedValues);

	const lineCount = getLineCount(rowHeight);

	const { visibleItems: visibleLabels, hiddenCount: hiddenBadgeCount } =
		useBadgeOverflow({
			items: displayLabels,
			getLabel: (label) => label,
			containerRef,
			lineCount,
		});

	return (
		<DataGridCellWrapper<TData>
			ref={containerRef}
			cell={cell}
			tableMeta={tableMeta}
			rowIndex={rowIndex}
			columnId={columnId}
			rowHeight={rowHeight}
			state={state}
			onKeyDown={onWrapperKeyDown}
		>
			{isEditing ? (
				<Popover open={isEditing} onOpenChange={onOpenChange}>
					<PopoverAnchor asChild>
						<div className="absolute inset-0" />
					</PopoverAnchor>
					<PopoverContent
						data-grid-cell-editor=""
						align="start"
						sideOffset={sideOffset}
						className="w-[300px] rounded-none p-0"
						onOpenAutoFocus={onOpenAutoFocus}
					>
						<Command className="**:data-[slot=command-input-wrapper]:h-auto **:data-[slot=command-input-wrapper]:border-none **:data-[slot=command-input-wrapper]:p-0 [&_[data-slot=command-input-wrapper]_svg]:hidden">
							<div className="flex min-h-9 flex-wrap items-center gap-1 border-b px-3 py-1.5">
								{selectedValues.map((value) => {
									const label = optionByValue.get(value)?.label ?? value;

									return (
										<Badge
											key={value}
											variant="secondary"
											className="gap-1 px-1.5 py-px"
										>
											{label}
											<button
												type="button"
												onClick={(event) => removeValue(value, event)}
												onPointerDown={(event) => {
													event.preventDefault();
													event.stopPropagation();
												}}
											>
												<X className="size-3" />
											</button>
										</Badge>
									);
								})}
								<CommandInput
									ref={inputRef}
									value={searchValue}
									onValueChange={setSearchValue}
									onKeyDown={onInputKeyDown}
									placeholder="Search..."
									className="h-auto flex-1 p-0"
								/>
							</div>
							<CommandList className="max-h-full">
								<CommandEmpty>{t("noOptionsFound")}</CommandEmpty>
								<CommandGroup className="max-h-[300px] scroll-py-1 overflow-y-auto overflow-x-hidden">
									{options.map((option) => {
										const isSelected = selectedValuesSet.has(option.value);

										return (
											<CommandItem
												key={option.value}
												value={option.label}
												onSelect={() => onValueChange(option.value)}
											>
												<div
													className={cn(
														"flex size-4 items-center justify-center rounded-sm border border-primary",
														isSelected
															? "bg-primary text-primary-foreground"
															: "opacity-50 [&_svg]:invisible",
													)}
												>
													<Check className="size-3" />
												</div>
												<span>{option.label}</span>
											</CommandItem>
										);
									})}
								</CommandGroup>
								{selectedValues.length > 0 && (
									<>
										<CommandSeparator />
										<CommandGroup>
											<CommandItem
												onSelect={clearAll}
												className="justify-center text-muted-foreground"
											>
												{t("clearAll")}
											</CommandItem>
										</CommandGroup>
									</>
								)}
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>
			) : null}
			{displayLabels.length > 0 ? (
				<div className="flex flex-wrap items-center gap-1 overflow-hidden">
					{visibleLabels.map((label, index) => (
						<Badge
							key={selectedValues[index]}
							variant="secondary"
							className="px-1.5 py-px"
						>
							{label}
						</Badge>
					))}
					{hiddenBadgeCount > 0 && (
						<Badge
							variant="outline"
							className="px-1.5 py-px text-muted-foreground"
						>
							+{hiddenBadgeCount}
						</Badge>
					)}
				</div>
			) : null}
		</DataGridCellWrapper>
	);
}

export function DateCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	state,
}: DataGridCellProps<TData>) {
	const { isEditing, isFocused, readOnly } = state;
	const initialValue = cell.getValue() as string;
	const [value, setValue] = React.useState(initialValue ?? "");
	const containerRef = React.useRef<HTMLDivElement>(null);

	const prevInitialValueRef = React.useRef(initialValue);
	// eslint-disable-next-line react-hooks-js/refs -- prev-prop compare-and-set: the condition reads the ref during render to derive cell state when the value prop changes (canonical React derive-on-prop-change idiom)
	if (initialValue !== prevInitialValueRef.current) {
		// eslint-disable-next-line react-hooks-js/refs -- valid prev-prop compare-and-set to derive state on prop change
		prevInitialValueRef.current = initialValue;
		setValue(initialValue ?? "");
	}

	// Parse date as local time to avoid timezone shifts
	const selectedDate = value ? (parseLocalDate(value) ?? undefined) : undefined;

	const onDateSelect = (date: Date | undefined) => {
		if (!date || readOnly) return;

		// Format using local date components to avoid timezone issues
		const formattedDate = formatDateToString(date);
		setValue(formattedDate);
		tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: formattedDate });
		tableMeta?.onCellEditingStop?.();
	};

	const onOpenChange = (open: boolean) => {
		if (open && !readOnly) {
			tableMeta?.onCellEditingStart?.(rowIndex, columnId);
		} else {
			tableMeta?.onCellEditingStop?.();
		}
	};

	const onWrapperKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (isEditing && event.key === "Escape") {
			event.preventDefault();
			setValue(initialValue);
			tableMeta?.onCellEditingStop?.();
		} else if (isFocused && event.key === "Tab") {
			event.preventDefault();
			tableMeta?.onCellEditingStop?.({
				direction: event.shiftKey ? "left" : "right",
			});
		}
	};

	return (
		<DataGridCellWrapper<TData>
			ref={containerRef}
			cell={cell}
			tableMeta={tableMeta}
			rowIndex={rowIndex}
			columnId={columnId}
			rowHeight={rowHeight}
			state={state}
			onKeyDown={onWrapperKeyDown}
		>
			<Popover open={isEditing} onOpenChange={onOpenChange}>
				<PopoverAnchor asChild>
					<span data-slot="grid-cell-content">
						{formatDateForDisplay(value)}
					</span>
				</PopoverAnchor>
				{isEditing && (
					<PopoverContent
						data-grid-cell-editor=""
						align="start"
						alignOffset={-8}
						className="w-auto p-0"
					>
						<Calendar
							autoFocus
							captionLayout="dropdown"
							mode="single"
							// eslint-disable-next-line react-doctor/rendering-hydration-mismatch-time -- client-only Tauri app, no SSR/hydration; new Date() is a defaultMonth fallback
							defaultMonth={selectedDate ?? new Date()}
							selected={selectedDate}
							onSelect={onDateSelect}
						/>
					</PopoverContent>
				)}
			</Popover>
		</DataGridCellWrapper>
	);
}

type FileCellState = {
	files: FileCellData[];
	uploadingFiles: Set<string>;
	deletingFiles: Set<string>;
	isDraggingOver: boolean;
	isDragging: boolean;
	error: string | null;
};

type FileCellAction =
	| { type: "resetFiles"; files: FileCellData[] }
	| { type: "clearError" }
	| { type: "setError"; error: string | null }
	| { type: "startUpload"; files: FileCellData[]; uploadingIds: Set<string> }
	| { type: "uploadFailed"; uploadingIds: Set<string> }
	| { type: "finishUpload"; files: FileCellData[] }
	| { type: "appendFiles"; files: FileCellData[] }
	| { type: "startDelete"; fileIds: string[] }
	| { type: "deleteFailed"; fileIds: string[] }
	| { type: "finishDelete"; files: FileCellData[]; fileIds: string[] }
	| { type: "clearDeleting" }
	| { type: "setDraggingOver"; value: boolean }
	| { type: "setDragging"; value: boolean };

function withoutIds(set: Set<string>, ids: string[]): Set<string> {
	const next = new Set(set);
	for (const id of ids) {
		next.delete(id);
	}
	return next;
}

function fileCellReducer(
	state: FileCellState,
	action: FileCellAction,
): FileCellState {
	switch (action.type) {
		case "resetFiles":
			return { ...state, files: action.files, error: null };
		case "clearError":
			return { ...state, error: null };
		case "setError":
			return { ...state, error: action.error };
		case "startUpload":
			return {
				...state,
				files: action.files,
				uploadingFiles: action.uploadingIds,
			};
		case "uploadFailed":
			return {
				...state,
				files: state.files.filter((f) => !action.uploadingIds.has(f.id)),
				uploadingFiles: new Set(),
			};
		case "finishUpload":
			return { ...state, files: action.files, uploadingFiles: new Set() };
		case "appendFiles":
			return { ...state, files: action.files };
		case "startDelete":
			return {
				...state,
				deletingFiles: new Set([...state.deletingFiles, ...action.fileIds]),
			};
		case "deleteFailed":
			return {
				...state,
				deletingFiles: withoutIds(state.deletingFiles, action.fileIds),
			};
		case "finishDelete":
			return {
				...state,
				files: action.files,
				deletingFiles: withoutIds(state.deletingFiles, action.fileIds),
			};
		case "clearDeleting":
			return { ...state, deletingFiles: new Set() };
		case "setDraggingOver":
			return { ...state, isDraggingOver: action.value };
		case "setDragging":
			return { ...state, isDragging: action.value };
		default:
			return state;
	}
}

type FileCellEditorProps = {
	labelId: string;
	descriptionId: string;
	files: FileCellData[];
	uploadingFiles: Set<string>;
	deletingFiles: Set<string>;
	isDragging: boolean;
	isPending: boolean;
	error: string | null;
	maxFileSize: number;
	maxFiles: number;
	multiple: boolean;
	accept: string | undefined;
	dropzoneRef: React.RefObject<HTMLDivElement | null>;
	fileInputRef: React.RefObject<HTMLInputElement | null>;
	onDropzoneClick: () => void;
	onDropzoneDragEnter: (event: React.DragEvent) => void;
	onDropzoneDragLeave: (event: React.DragEvent) => void;
	onDropzoneDrop: (event: React.DragEvent) => void;
	onDropzoneKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
	onFileInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
	onClearAll: () => void;
	onRemoveFile: (fileId: string) => void;
};

function FileCellEditor({
	labelId,
	descriptionId,
	files,
	uploadingFiles,
	deletingFiles,
	isDragging,
	isPending,
	error,
	maxFileSize,
	maxFiles,
	multiple,
	accept,
	dropzoneRef,
	fileInputRef,
	onDropzoneClick,
	onDropzoneDragEnter,
	onDropzoneDragLeave,
	onDropzoneDrop,
	onDropzoneKeyDown,
	onFileInputChange,
	onClearAll,
	onRemoveFile,
}: FileCellEditorProps) {
	const t = useTranslations("dataGrid");

	return (
		<div className="flex flex-col gap-2 p-3">
			<span id={labelId} className="sr-only">
				{t("fileUpload")}
			</span>
			<div
				// eslint-disable-next-line react-doctor/prefer-tag-over-role -- dropzone is interactive (click/drag/keyboard handlers + tabIndex); role=region is correct, a semantic tag would be non-interactive
				role="region"
				aria-labelledby={labelId}
				aria-describedby={descriptionId}
				data-dragging={isDragging ? "" : undefined}
				data-invalid={error ? "" : undefined}
				data-disabled={isPending ? "" : undefined}
				tabIndex={isDragging || isPending ? -1 : 0}
				className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 outline-none transition-colors hover:bg-accent/30 focus-visible:border-ring/50 data-disabled:pointer-events-none data-dragging:border-primary/30 data-invalid:border-destructive data-dragging:bg-accent/30 data-disabled:opacity-50 data-invalid:ring-destructive/20"
				ref={dropzoneRef}
				onClick={onDropzoneClick}
				onDragEnter={onDropzoneDragEnter}
				onDragLeave={onDropzoneDragLeave}
				onDragOver={preventAndStopDragEvent}
				onDrop={onDropzoneDrop}
				onKeyDown={onDropzoneKeyDown}
			>
				<Upload className="size-8 text-muted-foreground" />
				<div className="text-center text-sm">
					<p className="font-medium">
						{isDragging ? "Drop files here" : "Drag files here"}
					</p>
					<p className="text-muted-foreground text-xs">
						{t("orClickToBrowse")}
					</p>
				</div>
				<p id={descriptionId} className="text-muted-foreground text-xs">
					{maxFileSize
						? `Max size: ${formatFileSize(maxFileSize)}${maxFiles ? ` • Max ${maxFiles} files` : ""}`
						: maxFiles
							? `Max ${maxFiles} files`
							: "Select files to upload"}
				</p>
			</div>
			<input
				type="file"
				aria-labelledby={labelId}
				aria-describedby={descriptionId}
				multiple={multiple}
				accept={accept}
				className="sr-only"
				ref={fileInputRef}
				onChange={onFileInputChange}
			/>
			{files.length > 0 && (
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between">
						<p className="font-medium text-muted-foreground text-xs">
							{files.length} {files.length === 1 ? "file" : "files"}
						</p>
						<Button
							type="button"
							variant="ghost"
							className="h-6 text-muted-foreground text-xs"
							onClick={onClearAll}
							disabled={isPending}
						>
							{t("clearAll")}
						</Button>
					</div>
					<div className="max-h-[200px] space-y-1 overflow-y-auto">
						{files.map((file) => {
							const FileIcon = getFileIcon(file.type);
							const isFileUploading = uploadingFiles.has(file.id);
							const isFileDeleting = deletingFiles.has(file.id);
							const isFilePending = isFileUploading || isFileDeleting;

							return (
								<div
									key={file.id}
									data-pending={isFilePending ? "" : undefined}
									className="flex items-center gap-2 rounded-md border bg-muted/50 px-2 py-1.5 data-pending:opacity-60"
								>
									{FileIcon && (
										<FileIcon className="size-4 shrink-0 text-muted-foreground" />
									)}
									<div className="flex-1 overflow-hidden">
										<p className="truncate text-sm">{file.name}</p>
										<p className="text-muted-foreground text-xs">
											{isFileUploading
												? "Uploading..."
												: isFileDeleting
													? "Deleting..."
													: formatFileSize(file.size)}
										</p>
									</div>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="size-5 rounded-sm"
										onClick={() => onRemoveFile(file.id)}
										disabled={isPending}
									>
										<X className="size-3" />
									</Button>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}

type FileCellPreviewProps = {
	visibleFiles: FileCellData[];
	hiddenFileCount: number;
	uploadingFiles: Set<string>;
};

function FileCellPreview({
	visibleFiles,
	hiddenFileCount,
	uploadingFiles,
}: FileCellPreviewProps) {
	return (
		<div className="flex flex-wrap items-center gap-1 overflow-hidden">
			{visibleFiles.map((file) => {
				const isUploading = uploadingFiles.has(file.id);

				if (isUploading) {
					return (
						<Skeleton
							key={file.id}
							className="h-5 shrink-0 px-1.5"
							style={{
								width: `${Math.min(file.name.length * 8 + 30, 100)}px`,
							}}
						/>
					);
				}

				const FileIcon = getFileIcon(file.type);

				return (
					<Badge
						key={file.id}
						variant="secondary"
						className="gap-1 px-1.5 py-px"
					>
						{FileIcon && <FileIcon className="size-3 shrink-0" />}
						<span className="max-w-[100px] truncate">{file.name}</span>
					</Badge>
				);
			})}
			{hiddenFileCount > 0 && (
				<Badge variant="outline" className="px-1.5 py-px text-muted-foreground">
					+{hiddenFileCount}
				</Badge>
			)}
		</div>
	);
}

// eslint-disable-next-line react-doctor/no-giant-component -- the two largest view sections (FileCellEditor, FileCellPreview) are extracted; the residual body is cohesive async upload/delete state logic + render-phase compare-and-set ref reads that cannot be split into a hook/subcomponent without cursor/focus/positioning regression risk
export function FileCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	state,
}: DataGridCellProps<TData>) {
	const { isEditing, isFocused, readOnly } = state;
	const t = useTranslations("dataGrid");
	const cellValue = (cell.getValue() as FileCellData[]) ?? [];

	const cellKey = getCellKey(rowIndex, columnId);
	const prevCellKeyRef = React.useRef(cellKey);

	const labelId = React.useId();
	const descriptionId = React.useId();

	const [fileState, dispatch] = React.useReducer(
		fileCellReducer,
		undefined,
		() => ({
			files: cellValue,
			uploadingFiles: new Set<string>(),
			deletingFiles: new Set<string>(),
			isDraggingOver: false,
			isDragging: false,
			error: null as string | null,
		}),
	);
	const {
		files,
		uploadingFiles,
		deletingFiles,
		isDraggingOver,
		isDragging,
		error,
	} = fileState;

	const isUploading = uploadingFiles.size > 0;
	const isDeleting = deletingFiles.size > 0;
	const isPending = isUploading || isDeleting;
	const containerRef = React.useRef<HTMLDivElement>(null);
	const fileInputRef = React.useRef<HTMLInputElement>(null);
	const dropzoneRef = React.useRef<HTMLDivElement>(null);
	const cellOpts = cell.column.columnDef.meta?.cell;
	// eslint-disable-next-line react-hooks-js/refs -- popover offset is derived from a live DOM measurement; reading during render preserves existing positioning behavior
	const sideOffset = -(containerRef.current?.clientHeight ?? 0);

	const fileCellOpts = cellOpts?.variant === "file" ? cellOpts : null;
	const maxFileSize = fileCellOpts?.maxFileSize ?? 10 * 1024 * 1024;
	const maxFiles = fileCellOpts?.maxFiles ?? 10;
	const accept = fileCellOpts?.accept;
	const multiple = fileCellOpts?.multiple ?? false;

	const acceptedTypes = accept ? accept.split(",").map((t) => t.trim()) : null;

	const prevCellValueRef = React.useRef(cellValue);
	// eslint-disable-next-line react-hooks-js/refs -- prev-prop compare-and-set: the condition reads the ref during render to derive cell state when the value prop changes (canonical React derive-on-prop-change idiom)
	if (cellValue !== prevCellValueRef.current) {
		// eslint-disable-next-line react-hooks-js/refs -- valid prev-prop compare-and-set to derive state on prop change
		prevCellValueRef.current = cellValue;
		for (const file of files) {
			if (file.url) {
				URL.revokeObjectURL(file.url);
			}
		}
		dispatch({ type: "resetFiles", files: cellValue });
	}

	// eslint-disable-next-line react-hooks-js/refs -- valid prev-key compare-and-set to reset state when the cell identity changes
	if (prevCellKeyRef.current !== cellKey) {
		// eslint-disable-next-line react-hooks-js/refs -- valid prev-key compare-and-set to reset state when the cell identity changes
		prevCellKeyRef.current = cellKey;
		dispatch({ type: "clearError" });
	}

	const validateFile = (file: File): string | null => {
		if (maxFileSize && file.size > maxFileSize) {
			return `File size exceeds ${formatFileSize(maxFileSize)}`;
		}
		if (acceptedTypes) {
			const fileExtension = `.${file.name.split(".").pop()}`;
			const isAccepted = acceptedTypes.some((type) => {
				if (type.endsWith("/*")) {
					const baseType = type.slice(0, -2);
					return file.type.startsWith(`${baseType}/`);
				}
				if (type.startsWith(".")) {
					return fileExtension.toLowerCase() === type.toLowerCase();
				}
				return file.type === type;
			});
			if (!isAccepted) {
				return "File type not accepted";
			}
		}
		return null;
	};

	const addFiles = async (newFiles: File[], skipUpload = false) => {
		if (readOnly || isPending) return;
		dispatch({ type: "clearError" });

		if (maxFiles && files.length + newFiles.length > maxFiles) {
			const errorMessage = `Maximum ${maxFiles} files allowed`;
			dispatch({ type: "setError", error: errorMessage });
			toast(errorMessage);
			setTimeout(() => {
				dispatch({ type: "clearError" });
			}, 2000);
			return;
		}

		const rejectedFiles: Array<{ name: string; reason: string }> = [];
		const filesToValidate: File[] = [];

		for (const file of newFiles) {
			const validationError = validateFile(file);
			if (validationError) {
				rejectedFiles.push({ name: file.name, reason: validationError });
				continue;
			}
			filesToValidate.push(file);
		}

		if (rejectedFiles.length > 0) {
			const firstError = rejectedFiles[0];
			if (firstError) {
				dispatch({ type: "setError", error: firstError.reason });

				const truncatedName =
					firstError.name.length > 20
						? `${firstError.name.slice(0, 20)}...`
						: firstError.name;

				if (rejectedFiles.length === 1) {
					toast(firstError.reason, {
						description: `"${truncatedName}" has been rejected`,
					});
				} else {
					toast(firstError.reason, {
						description: `"${truncatedName}" and ${rejectedFiles.length - 1} more rejected`,
					});
				}

				setTimeout(() => {
					dispatch({ type: "clearError" });
				}, 2000);
			}
		}

		if (filesToValidate.length > 0) {
			if (!skipUpload) {
				const tempFiles = filesToValidate.map((f) => ({
					id: crypto.randomUUID() as string,
					name: f.name,
					size: f.size,
					type: f.type,
					url: undefined,
				}));
				const filesWithTemp = [...files, ...tempFiles];
				const uploadingIds = new Set(tempFiles.map((f) => f.id));
				dispatch({
					type: "startUpload",
					files: filesWithTemp,
					uploadingIds,
				});

				let uploadedFiles: FileCellData[] = [];

				if (tableMeta?.onFilesUpload) {
					try {
						uploadedFiles = await tableMeta.onFilesUpload({
							files: filesToValidate,
							rowIndex,
							columnId,
						});
					} catch (error) {
						toast.error(
							error instanceof Error
								? error.message
								: `Failed to upload ${filesToValidate.length} file${filesToValidate.length !== 1 ? "s" : ""}`,
						);
						dispatch({ type: "uploadFailed", uploadingIds });
						return;
					}
				} else {
					uploadedFiles = filesToValidate.map((f, i) => ({
						id: tempFiles[i]?.id ?? (crypto.randomUUID() as string),
						name: f.name,
						size: f.size,
						type: f.type,
						url: URL.createObjectURL(f),
					}));
				}

				const finalFiles = filesWithTemp
					.map((f) => {
						if (uploadingIds.has(f.id)) {
							return uploadedFiles.find((uf) => uf.name === f.name) ?? f;
						}
						return f;
					})
					.filter((f) => f.url !== undefined);

				dispatch({ type: "finishUpload", files: finalFiles });
				tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: finalFiles });
			} else {
				const newFilesData: FileCellData[] = filesToValidate.map((f) => ({
					id: crypto.randomUUID() as string,
					name: f.name,
					size: f.size,
					type: f.type,
					url: URL.createObjectURL(f),
				}));
				const updatedFiles = [...files, ...newFilesData];
				dispatch({ type: "appendFiles", files: updatedFiles });
				tableMeta?.onDataUpdate?.({
					rowIndex,
					columnId,
					value: updatedFiles,
				});
			}
		}
	};

	const removeFile = async (fileId: string) => {
		if (readOnly || isPending) return;
		dispatch({ type: "clearError" });

		const fileToRemove = files.find((f) => f.id === fileId);
		if (!fileToRemove) return;

		dispatch({ type: "startDelete", fileIds: [fileId] });

		if (tableMeta?.onFilesDelete) {
			try {
				await tableMeta.onFilesDelete({
					fileIds: [fileId],
					rowIndex,
					columnId,
				});
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: `Failed to delete ${fileToRemove.name}`,
				);
				dispatch({ type: "deleteFailed", fileIds: [fileId] });
				return;
			}
		}

		if (fileToRemove.url?.startsWith("blob:")) {
			URL.revokeObjectURL(fileToRemove.url);
		}

		const updatedFiles = files.filter((f) => f.id !== fileId);
		dispatch({ type: "finishDelete", files: updatedFiles, fileIds: [fileId] });
		tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: updatedFiles });
	};

	const clearAll = async () => {
		if (readOnly || isPending) return;
		dispatch({ type: "clearError" });

		const fileIds = files.map((f) => f.id);
		dispatch({ type: "startDelete", fileIds });

		if (tableMeta?.onFilesDelete && files.length > 0) {
			try {
				await tableMeta.onFilesDelete({
					fileIds,
					rowIndex,
					columnId,
				});
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to delete files",
				);
				dispatch({ type: "clearDeleting" });
				return;
			}
		}

		for (const file of files) {
			if (file.url?.startsWith("blob:")) {
				URL.revokeObjectURL(file.url);
			}
		}
		dispatch({ type: "finishDelete", files: [], fileIds });
		tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: [] });
	};

	const onCellDragEnter = (event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer.types.includes("Files")) {
			dispatch({ type: "setDraggingOver", value: true });
		}
	};

	const onCellDragLeave = (event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		const rect = event.currentTarget.getBoundingClientRect();
		const x = event.clientX;
		const y = event.clientY;

		if (
			x <= rect.left ||
			x >= rect.right ||
			y <= rect.top ||
			y >= rect.bottom
		) {
			dispatch({ type: "setDraggingOver", value: false });
		}
	};

	const onCellDrop = (event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		dispatch({ type: "setDraggingOver", value: false });

		const droppedFiles = Array.from(event.dataTransfer.files);
		if (droppedFiles.length > 0) {
			addFiles(droppedFiles, false);
		}
	};

	const onDropzoneDragEnter = (event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		dispatch({ type: "setDragging", value: true });
	};

	const onDropzoneDragLeave = (event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		const rect = event.currentTarget.getBoundingClientRect();
		const x = event.clientX;
		const y = event.clientY;

		if (
			x <= rect.left ||
			x >= rect.right ||
			y <= rect.top ||
			y >= rect.bottom
		) {
			dispatch({ type: "setDragging", value: false });
		}
	};

	const onDropzoneDrop = (event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		dispatch({ type: "setDragging", value: false });

		const droppedFiles = Array.from(event.dataTransfer.files);
		addFiles(droppedFiles, false);
	};

	const onDropzoneClick = () => {
		fileInputRef.current?.click();
	};

	const onDropzoneKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onDropzoneClick();
		}
	};

	const onFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const selectedFiles = Array.from(event.target.files ?? []);
		addFiles(selectedFiles, false);
		event.target.value = "";
	};

	const onOpenChange = (open: boolean) => {
		if (open && !readOnly) {
			dispatch({ type: "clearError" });
			tableMeta?.onCellEditingStart?.(rowIndex, columnId);
		} else {
			dispatch({ type: "clearError" });
			tableMeta?.onCellEditingStop?.();
		}
	};

	const onOpenAutoFocus: NonNullable<
		React.ComponentProps<typeof PopoverContent>["onOpenAutoFocus"]
	> = (event) => {
		event.preventDefault();
		queueMicrotask(() => {
			dropzoneRef.current?.focus();
		});
	};

	const onWrapperKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (isEditing) {
			if (event.key === "Escape") {
				event.preventDefault();
				dispatch({ type: "resetFiles", files: cellValue });
				tableMeta?.onCellEditingStop?.();
			} else if (event.key === " ") {
				event.preventDefault();
				onDropzoneClick();
			} else if (event.key === "Tab") {
				event.preventDefault();
				tableMeta?.onCellEditingStop?.({
					direction: event.shiftKey ? "left" : "right",
				});
			}
		} else if (isFocused && event.key === "Enter") {
			event.preventDefault();
			tableMeta?.onCellEditingStart?.(rowIndex, columnId);
		} else if (isFocused && event.key === "Tab") {
			event.preventDefault();
			tableMeta?.onCellEditingStop?.({
				direction: event.shiftKey ? "left" : "right",
			});
		}
	};

	React.useEffect(() => {
		return () => {
			for (const file of files) {
				if (file.url) {
					URL.revokeObjectURL(file.url);
				}
			}
		};
	}, [files]);

	const lineCount = getLineCount(rowHeight);

	const { visibleItems: visibleFiles, hiddenCount: hiddenFileCount } =
		useBadgeOverflow({
			items: files,
			getLabel: (file) => file.name,
			containerRef,
			lineCount,
			cacheKeyPrefix: "file",
			iconSize: 12,
			maxWidth: 100,
		});

	return (
		<DataGridCellWrapper<TData>
			ref={containerRef}
			cell={cell}
			tableMeta={tableMeta}
			rowIndex={rowIndex}
			columnId={columnId}
			rowHeight={rowHeight}
			state={state}
			className={cn({
				"ring-1 ring-primary/80 ring-inset": isDraggingOver,
			})}
			onDragEnter={onCellDragEnter}
			onDragLeave={onCellDragLeave}
			onDragOver={preventAndStopDragEvent}
			onDrop={onCellDrop}
			onKeyDown={onWrapperKeyDown}
		>
			{isEditing ? (
				<Popover open={isEditing} onOpenChange={onOpenChange}>
					<PopoverAnchor asChild>
						<div className="absolute inset-0" />
					</PopoverAnchor>
					<PopoverContent
						data-grid-cell-editor=""
						align="start"
						sideOffset={sideOffset}
						className="w-[400px] rounded-none p-0"
						onEscapeKeyDown={onEditorEscapeKeyDown}
						onOpenAutoFocus={onOpenAutoFocus}
					>
						<FileCellEditor
							labelId={labelId}
							descriptionId={descriptionId}
							files={files}
							uploadingFiles={uploadingFiles}
							deletingFiles={deletingFiles}
							isDragging={isDragging}
							isPending={isPending}
							error={error}
							maxFileSize={maxFileSize}
							maxFiles={maxFiles}
							multiple={multiple}
							accept={accept}
							dropzoneRef={dropzoneRef}
							fileInputRef={fileInputRef}
							onDropzoneClick={onDropzoneClick}
							onDropzoneDragEnter={onDropzoneDragEnter}
							onDropzoneDragLeave={onDropzoneDragLeave}
							onDropzoneDrop={onDropzoneDrop}
							onDropzoneKeyDown={onDropzoneKeyDown}
							onFileInputChange={onFileInputChange}
							onClearAll={clearAll}
							onRemoveFile={removeFile}
						/>
					</PopoverContent>
				</Popover>
			) : null}
			{isDraggingOver ? (
				<div className="flex items-center justify-center gap-2 text-primary text-sm">
					<Upload className="size-4" />
					<span>{t("dropFilesHere")}</span>
				</div>
			) : files.length > 0 ? (
				<FileCellPreview
					visibleFiles={visibleFiles}
					hiddenFileCount={hiddenFileCount}
					uploadingFiles={uploadingFiles}
				/>
			) : null}
		</DataGridCellWrapper>
	);
}

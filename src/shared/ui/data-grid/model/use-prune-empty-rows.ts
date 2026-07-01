import { type FocusEvent, type RefObject, useRef } from "react";

interface UsePruneEmptyRowsOptions<TData> {
	/** Latest rows (a ref so the handler never goes stale). */
	dataRef: { current: TData[] };
	/** True when a row carries no real content (an abandoned "Add row"). */
	isEmpty: (row: TData) => boolean;
	/** Persist the pruned rows. */
	onChange: (rows: TData[]) => void;
}

/**
 * Spreadsheet grids add a blank row on "Add row" so you can type into it. This
 * drops any fully-empty rows once focus leaves the grid, so abandoned blank
 * rows never accumulate, count, or persist. Rows stay put while you're editing
 * inside the grid (focus moving cell-to-cell keeps `relatedTarget` within the
 * wrapper); only when focus exits entirely are the blanks swept.
 */
export function usePruneEmptyRows<TData>({
	dataRef,
	isEmpty,
	onChange,
}: UsePruneEmptyRowsOptions<TData>): {
	wrapperRef: RefObject<HTMLDivElement | null>;
	onBlur: (event: FocusEvent<HTMLDivElement>) => void;
} {
	const wrapperRef = useRef<HTMLDivElement | null>(null);

	const onBlur = (event: FocusEvent<HTMLDivElement>) => {
		const next = event.relatedTarget;
		// Focus stayed somewhere inside the grid — keep editing, don't prune.
		if (next instanceof Node && wrapperRef.current?.contains(next)) {
			return;
		}
		const current = dataRef.current;
		const pruned = current.filter((row) => !isEmpty(row));
		if (pruned.length !== current.length) {
			onChange(pruned);
		}
	};

	return { wrapperRef, onBlur };
}

import {
	ChevronDown,
	ChevronUp,
	X,
} from "@/shared/ui/data-grid/primitives/icons";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/shared/ui/data-grid/primitives/button";
import { Input } from "@/shared/ui/data-grid/primitives/input";
import { useAsRef } from "@/shared/ui/data-grid/model/use-as-ref";
import { useDebouncedCallback } from "@/shared/ui/data-grid/model/use-debounced-callback";
import type { SearchState } from "@/shared/ui/data-grid/types";

function onTriggerPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	if (target.hasPointerCapture(event.pointerId)) {
		target.releasePointerCapture(event.pointerId);
	}

	// Prevent the trigger from stealing focus away from the input
	if (
		event.button === 0 &&
		event.ctrlKey === false &&
		event.pointerType === "mouse" &&
		!(event.target instanceof HTMLInputElement)
	) {
		event.preventDefault();
	}
}

interface DataGridSearchProps extends SearchState {}

export function DataGridSearch({
	searchMatches,
	matchIndex,
	searchOpen,
	onSearchOpenChange,
	searchQuery,
	onSearchQueryChange,
	onSearch,
	onNavigateToNextMatch,
	onNavigateToPrevMatch,
}: DataGridSearchProps) {
	const t = useTranslations("dataGrid");
	const propsRef = useAsRef({
		onSearchOpenChange,
		onSearchQueryChange,
		onSearch,
		onNavigateToNextMatch,
		onNavigateToPrevMatch,
	});

	const inputRef = React.useRef<HTMLInputElement>(null);
	const isComposingRef = React.useRef(false);
	const [hasQuery, setHasQuery] = React.useState(searchQuery.length > 0);

	React.useEffect(() => {
		// eslint-disable-next-line react-doctor/no-event-handler -- searchOpen is a parent-controlled prop that opens/closes externally; this effect syncs focus-on-open and reset-on-close to that prop, which cannot live in a single local event handler.
		if (searchOpen) {
			requestAnimationFrame(() => {
				inputRef.current?.focus();
			});
			return;
		}

		isComposingRef.current = false;
		// eslint-disable-next-line react-doctor/no-derived-state, react-hooks-js/set-state-in-effect, react-doctor/no-event-handler -- hasQuery tracks the UNCONTROLLED input (defaultValue); it cannot be derived during render. searchOpen is a parent-controlled prop that can close externally (not only via local onClose), so this reset must sync to the prop here, not in a local event handler. The same effect also syncs DOM focus on open.
		setHasQuery(false);
	}, [searchOpen]);

	React.useEffect(() => {
		if (!searchOpen) return;

		function onEscape(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				propsRef.current.onSearchOpenChange(false);
			}
		}

		document.addEventListener("keydown", onEscape);
		return () => document.removeEventListener("keydown", onEscape);
	}, [searchOpen, propsRef]);

	const debouncedSearch = useDebouncedCallback((query: string) => {
		propsRef.current.onSearch(query);
	}, 150);

	function onCompositionStart() {
		isComposingRef.current = true;
	}

	function onCompositionEnd(event: React.CompositionEvent<HTMLInputElement>) {
		isComposingRef.current = false;
		const value = event.currentTarget.value;
		setHasQuery(value.length > 0);
		propsRef.current.onSearchQueryChange(value);
		debouncedSearch(value);
	}

	function onKeyDown(event: React.KeyboardEvent) {
		event.stopPropagation();

		if (event.key === "Enter") {
			if (event.nativeEvent.isComposing) return;
			event.preventDefault();
			if (event.shiftKey) {
				propsRef.current.onNavigateToPrevMatch();
			} else {
				propsRef.current.onNavigateToNextMatch();
			}
		}
	}

	function onChange(event: React.ChangeEvent<HTMLInputElement>) {
		if (isComposingRef.current) return;
		const value = event.target.value;
		setHasQuery(value.length > 0);
		propsRef.current.onSearchQueryChange(value);
		debouncedSearch(value);
	}

	function onClose() {
		propsRef.current.onSearchOpenChange(false);
	}

	function onPrevMatch() {
		propsRef.current.onNavigateToPrevMatch();
	}

	function onNextMatch() {
		propsRef.current.onNavigateToNextMatch();
	}

	if (!searchOpen) return null;

	return (
		<search
			data-slot="grid-search"
			className="fade-in-0 slide-in-from-top-2 absolute end-4 top-4 z-overlay flex animate-in flex-col gap-2 rounded-lg border border-border bg-surface-5 p-2 shadow-overlay"
		>
			<div className="flex items-center gap-2">
				<Input
					autoComplete="off"
					autoCorrect="off"
					autoCapitalize="off"
					spellCheck={false}
					placeholder="Find in table..."
					className="h-8 w-64"
					ref={inputRef}
					defaultValue={searchQuery}
					onChange={onChange}
					onKeyDown={onKeyDown}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
				/>
				<div className="flex items-center gap-1">
					<Button
						aria-label="Previous match"
						variant="ghost"
						size="icon"
						className="size-7"
						onClick={onPrevMatch}
						onPointerDown={onTriggerPointerDown}
						disabled={searchMatches.length === 0}
					>
						<ChevronUp />
					</Button>
					<Button
						aria-label="Next match"
						variant="ghost"
						size="icon"
						className="size-7"
						onClick={onNextMatch}
						onPointerDown={onTriggerPointerDown}
						disabled={searchMatches.length === 0}
					>
						<ChevronDown />
					</Button>
					<Button
						aria-label="Close search"
						variant="ghost"
						size="icon"
						className="size-7"
						onClick={onClose}
					>
						<X />
					</Button>
				</div>
			</div>
			<div className="flex items-center gap-1 whitespace-nowrap text-muted-foreground text-xs">
				{searchMatches.length > 0 ? (
					<span>
						{t("matchPosition", {
							current: matchIndex + 1,
							total: searchMatches.length,
						})}
					</span>
				) : hasQuery ? (
					<span>{t("noResults")}</span>
				) : (
					<span>{t("typeToSearch")}</span>
				)}
			</div>
		</search>
	);
}

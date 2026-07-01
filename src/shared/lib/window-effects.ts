import { useEffect } from "react";

export function useTransparentBody() {
	useEffect(() => {
		document.documentElement.classList.add("bg-transparent");
		document.body.classList.add("bg-transparent");
		return () => {
			document.documentElement.classList.remove("bg-transparent");
			document.body.classList.remove("bg-transparent");
		};
	}, []);
}

const DEFAULT_ESCAPE_BLOCKING_LAYER_SELECTOR = [
	'[role="dialog"]',
	'[role="alertdialog"]',
	'[role="menu"]',
	'[role="listbox"]',
	'[data-slot="model-filters-menu-content"]',
	'[data-slot="ollama-filters-menu-content"]',
	'[data-slot="stt-filters-menu-content"]',
].join(",");

function isVisibleLayer(element: HTMLElement): boolean {
	const style = window.getComputedStyle(element);
	return (
		style.display !== "none" &&
		style.visibility !== "hidden" &&
		element.getClientRects().length > 0
	);
}

function hasVisibleBlockingLayer(
	selector: string,
	ignoreLayer?: (element: HTMLElement) => boolean,
): boolean {
	for (const layer of document.querySelectorAll<HTMLElement>(selector)) {
		if (!ignoreLayer?.(layer) && isVisibleLayer(layer)) {
			return true;
		}
	}
	return false;
}

export interface EscapeToCloseOptions {
	/** Ignore a matched visible layer. Used by detached picker windows whose
	 *  primary inline listbox is always open but should not block window Escape. */
	ignoreLayer?: (element: HTMLElement) => boolean;
	/** Visible layers that should receive Escape before the owning window closes. */
	blockingLayerSelector?: string;
}

export function useEscapeToClose(
	close: () => void,
	options: EscapeToCloseOptions = {},
) {
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (
				e.key === "Escape" &&
				!e.defaultPrevented &&
				!hasVisibleBlockingLayer(
					options.blockingLayerSelector ??
						DEFAULT_ESCAPE_BLOCKING_LAYER_SELECTOR,
					options.ignoreLayer,
				)
			) {
				close();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [close, options.blockingLayerSelector, options.ignoreLayer]);
}

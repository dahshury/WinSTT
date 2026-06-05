import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

declare global {
	interface Window {
		__winsttReactRoots?: WeakMap<Element, Root>;
	}
}

function getRootCache(): WeakMap<Element, Root> {
	window.__winsttReactRoots ??= new WeakMap<Element, Root>();
	return window.__winsttReactRoots;
}

export function renderReactRoot(container: Element, node: ReactNode): void {
	const roots = getRootCache();
	let root = roots.get(container);
	if (!root) {
		root = createRoot(container);
		roots.set(container, root);
	}
	root.render(node);
}

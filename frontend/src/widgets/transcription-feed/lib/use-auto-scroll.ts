import { type DependencyList, useEffect, useRef } from "react";

export function useAutoScroll<T extends HTMLElement>(deps: DependencyList) {
	const ref = useRef<T>(null);

	useEffect(() => {
		const el = ref.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: caller controls when scrolling triggers via `deps`
	}, deps);

	return ref;
}

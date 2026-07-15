import { useEffect, useState } from "react";

/**
 * Opens a loading boundary only after the browser has had an opportunity to
 * present the lightweight shell. Two animation frames are intentional: the
 * first callback runs before a paint, while the second runs after it.
 */
export function useAfterFirstPaint(): boolean {
	const [ready, setReady] = useState(false);

	useEffect(() => {
		let secondFrame = 0;
		const firstFrame = window.requestAnimationFrame(() => {
			secondFrame = window.requestAnimationFrame(() => setReady(true));
		});

		return () => {
			window.cancelAnimationFrame(firstFrame);
			if (secondFrame !== 0) {
				window.cancelAnimationFrame(secondFrame);
			}
		};
	}, []);

	return ready;
}

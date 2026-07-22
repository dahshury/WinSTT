import { useEffect, useState } from "react";

function pickFrame(sequence: number[][], index: number): number[] {
	return sequence[index % sequence.length] ?? [];
}

export function useSequenceAnimator(
	sequence: number[][],
	inputsKey: string,
	interval: number,
): number[] {
	const [index, setIndex] = useState(0);
	const [prevInputsKey, setPrevInputsKey] = useState(inputsKey);
	const inputsAreCurrent = prevInputsKey === inputsKey;
	if (!inputsAreCurrent) {
		setPrevInputsKey(inputsKey);
		setIndex(0);
	}

	const frameCount = sequence.length;
	useEffect(() => {
		// Sequence length <= 1 means cycling the index changes nothing. Skip the
		// timer entirely so idle visualizers do no background work.
		if (frameCount <= 1 || !Number.isFinite(interval)) {
			return;
		}

		let timeoutId: number | null = null;
		let nextTransitionAt = performance.now() + interval;

		const clearScheduledTransition = () => {
			if (timeoutId !== null) {
				window.clearTimeout(timeoutId);
				timeoutId = null;
			}
		};

		const scheduleNextTransition = () => {
			if (document.hidden || timeoutId !== null) {
				return;
			}

			timeoutId = window.setTimeout(
				() => {
					timeoutId = null;
					setIndex((prev) => prev + 1);
					nextTransitionAt = performance.now() + interval;
					scheduleNextTransition();
				},
				Math.max(0, nextTransitionAt - performance.now()),
			);
		};

		const handleVisibilityChange = () => {
			clearScheduledTransition();
			scheduleNextTransition();
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);
		scheduleNextTransition();

		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			clearScheduledTransition();
		};
		// react-doctor-disable-next-line react-doctor/exhaustive-deps -- inputsKey is an intentional dependency (not read in the body): it restarts the transition deadline in lockstep with the render-phase index reset so each new input sequence shows frame 0 for a full interval.
	}, [frameCount, inputsKey, interval]);

	return pickFrame(sequence, inputsAreCurrent ? index : 0);
}

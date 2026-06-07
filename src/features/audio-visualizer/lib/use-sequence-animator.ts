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
		// Sequence length <= 1 means cycling the index changes nothing. Skip rAF
		// entirely so idle visualizers do not burn a 60 fps loop per BrowserWindow.
		if (frameCount <= 1 || !Number.isFinite(interval)) {
			return;
		}

		let animationFrameId: number | null = null;
		let startTime = performance.now();
		const animate = (time: DOMHighResTimeStamp) => {
			if (time - startTime >= interval) {
				setIndex((prev) => prev + 1);
				startTime = time;
			}
			animationFrameId = requestAnimationFrame(animate);
		};

		animationFrameId = requestAnimationFrame(animate);
		return () => {
			if (animationFrameId !== null) {
				cancelAnimationFrame(animationFrameId);
			}
		};
	}, [frameCount, inputsKey, interval]);

	return pickFrame(sequence, inputsAreCurrent ? index : 0);
}

"use client";

import { useCallback, useEffect, useState } from "react";

export function useKeyRecorder() {
	const [recording, setRecording] = useState(false);
	const [key, setKey] = useState<string | null>(null);

	const startRecording = useCallback(() => {
		setRecording(true);
		setKey(null);
	}, []);

	const stopRecording = useCallback(() => {
		setRecording(false);
	}, []);

	useEffect(() => {
		if (!recording) {
			return;
		}

		const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

		function handleKeyDown(e: KeyboardEvent) {
			e.preventDefault();
			e.stopPropagation();

			const keyName = e.key === " " ? "Space" : e.key;

			// Ignore solo modifier presses - wait for a real key or combo
			if (MODIFIER_KEYS.has(keyName)) {
				return;
			}

			const modifiers = [
				e.ctrlKey && "Control",
				e.altKey && "Alt",
				e.shiftKey && "Shift",
				e.metaKey && "Meta",
			].filter(Boolean) as string[];

			const parts = [...modifiers, keyName];
			setKey(parts.join("+"));
			setRecording(false);
		}

		window.addEventListener("keydown", handleKeyDown, true);
		return () => window.removeEventListener("keydown", handleKeyDown, true);
	}, [recording]);

	return { recording, key, startRecording, stopRecording };
}

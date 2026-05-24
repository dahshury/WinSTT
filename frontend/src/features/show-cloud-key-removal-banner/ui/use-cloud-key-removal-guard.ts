"use client";

import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
import type { CloudSttProvider } from "@/shared/api/models";

interface KeyRemovalNotice {
	provider: CloudSttProvider;
	timestamp: number;
}

/**
 * Detects the transition "active main STT model is `provider:*` AND the
 * provider's apiKey has just been cleared" and surfaces a persistent
 * notice the caller can render as a sticky banner. Returning a notice
 * is intentional: the brief says we do NOT auto-switch to a local model
 * — the user picked cloud explicitly, we just have to tell them the
 * current pick is now broken.
 *
 * Once the user either restores a key OR switches off the cloud model,
 * the notice clears automatically (the precondition is gone).
 */
export function useCloudKeyRemovalGuard(): KeyRemovalNotice | null {
	const model = useSettingsStore((s) => s.settings.model?.model ?? "");
	const openaiKey = useSettingsStore((s) => s.settings.integrations.openai.apiKey);
	const elevenlabsKey = useSettingsStore((s) => s.settings.integrations.elevenlabs.apiKey);

	const [notice, setNotice] = useState<KeyRemovalNotice | null>(null);
	const prevOpenaiKey = useRef(openaiKey);
	const prevElevenlabsKey = useRef(elevenlabsKey);

	useEffect(() => {
		// Detect a non-empty → empty transition for whichever provider matches
		// the active main model. Only flag the transition once; the notice
		// persists until the active model or the key changes again.
		if (model.startsWith("openai:") && prevOpenaiKey.current.trim() !== "" && openaiKey === "") {
			setNotice({ provider: "openai", timestamp: Date.now() });
		}
		if (
			model.startsWith("elevenlabs:") &&
			prevElevenlabsKey.current.trim() !== "" &&
			elevenlabsKey === ""
		) {
			setNotice({ provider: "elevenlabs", timestamp: Date.now() });
		}
		prevOpenaiKey.current = openaiKey;
		prevElevenlabsKey.current = elevenlabsKey;
	}, [model, openaiKey, elevenlabsKey]);

	// Auto-clear the notice once the precondition is gone — either the user
	// restored a key, or they switched away from the cloud model.
	useEffect(() => {
		if (!notice) {
			return;
		}
		const cleared = !model.startsWith(`${notice.provider}:`);
		const restored =
			(notice.provider === "openai" && openaiKey.trim() !== "") ||
			(notice.provider === "elevenlabs" && elevenlabsKey.trim() !== "");
		if (cleared || restored) {
			setNotice(null);
		}
	}, [notice, model, openaiKey, elevenlabsKey]);

	return notice;
}

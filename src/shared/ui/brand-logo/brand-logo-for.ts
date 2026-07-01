import { createElement, type ReactNode } from "react";
import {
	ElevenLabsLogo,
	OllamaLogo,
	OpenRouterLogo,
	type BrandLogoProps,
} from "./BrandLogo";

export function brandLogoFor(
	name: string | null | undefined,
	props?: BrandLogoProps,
): ReactNode {
	switch (name?.toLowerCase().trim()) {
		case "ollama":
			return createElement(OllamaLogo, props);
		case "openrouter":
			return createElement(OpenRouterLogo, props);
		case "elevenlabs":
			return createElement(ElevenLabsLogo, props);
		default:
			return null;
	}
}

import { createProviderIconResolver } from "@/shared/lib/provider-icon-resolver";
import { publicAsset } from "./public-asset";

const PROVIDER_NAME_ALIASES: Record<string, string> = {
	meta: "meta-llama",
	mistral: "mistralai",
	xai: "x-ai",
};

const resolveProviderIconPath = createProviderIconResolver(
	PROVIDER_NAME_ALIASES,
);

export function getProviderIcon(
	provider: string | null | undefined,
): string | null {
	return resolveProviderIconPath(provider);
}

/**
 * Like {@link getProviderIconWithFallback} but returns `null` (renderer-root
 * resolved when found) when the maker has no bundled logo — so callers can render
 * a neutral initials chip instead of the misleading OpenRouter "O" fallback.
 */
export function resolveProviderIcon(
	provider: string | null | undefined,
): string | null {
	const path = getProviderIcon(provider);
	return path ? publicAsset(path) : null;
}

/**
 * The bundled `/public/provider-icons/` directory has no `default.png`, so we
 * fall back to the OpenRouter icon (which is part of the same set) when an
 * unknown maker slug is encountered. Callers can override via `fallback`.
 */
export function getProviderIconWithFallback(
	provider: string | null | undefined,
	fallback?: string,
): string {
	// Resolve to a renderer-root-relative URL so the icon loads under file://
	// in packaged builds (the absolute "/provider-icons/x.png" form only works
	// against the dev server root). See public-asset.ts.
	return publicAsset(
		getProviderIcon(provider) || fallback || "/provider-icons/openrouter.svg",
	);
}

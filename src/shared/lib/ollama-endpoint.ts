const TRAILING_API_PATH = /\/(?:api|v1)$/i;
const TRAILING_SLASHES = /\/+$/;

function stripTrailingSlashes(value: string): string {
	return value.replace(TRAILING_SLASHES, "");
}

function stripTrailingApiSegments(value: string): string {
	let result = stripTrailingSlashes(value);
	while (TRAILING_API_PATH.test(result)) {
		result = stripTrailingSlashes(result.replace(TRAILING_API_PATH, ""));
	}
	return result;
}

function normalizeLooseEndpoint(value: string): string {
	let result = value.trim();
	while (true) {
		const next = stripTrailingApiSegments(result).trim();
		if (next === result) {
			return result;
		}
		result = next;
	}
}

export function normalizeOllamaEndpoint(endpoint: string): string {
	const trimmed = endpoint.trim();
	try {
		const url = new URL(trimmed);
		// URL spec: assigning an empty pathname to an http/https URL is
		// auto-normalized back to "/", so an explicit `|| "/"` fallback is
		// redundant.
		url.pathname = stripTrailingApiSegments(url.pathname);
		url.search = "";
		url.hash = "";
		return stripTrailingSlashes(url.toString());
	} catch {
		// Empty input and non-URL strings both flow here. The while loop
		// is a no-op for empty input, so the early-return guard is also
		// redundant.
		return normalizeLooseEndpoint(trimmed);
	}
}

export type OllamaEndpointValidation =
	| { endpoint: string; ok: true }
	| { ok: false };

function isLoopbackHost(hostname: string): boolean {
	const host = hostname
		.trim()
		.replace(/^\[/, "")
		.replace(/\]$/, "")
		.toLowerCase();
	if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
		return true;
	}
	const octets = host.split(".");
	return (
		octets.length === 4 &&
		octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
		Number(octets[0]) === 127
	);
}

/**
 * Mirror the native SSRF boundary before an endpoint reaches canonical
 * settings. Invalid/remote drafts stay in the field for correction but are
 * never persisted for the backend to request.
 */
export function validateLoopbackOllamaEndpoint(
	endpoint: string,
): OllamaEndpointValidation {
	const normalized = normalizeOllamaEndpoint(endpoint);
	if (normalized.length === 0) {
		return { ok: false };
	}
	try {
		const url = new URL(normalized);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return { ok: false };
		}
		if (url.username.length > 0 || url.password.length > 0) {
			return { ok: false };
		}
		if (!isLoopbackHost(url.hostname)) {
			return { ok: false };
		}
		return { endpoint: normalized, ok: true };
	} catch {
		return { ok: false };
	}
}

export function buildOllamaApiUrl(
	endpoint: string,
	apiPath: `/api/${string}`,
): string {
	const normalized = normalizeOllamaEndpoint(endpoint);
	const normalizedApiPath = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;

	try {
		const url = new URL(normalized);
		// stripTrailingSlashes("/") === "" so the explicit pathname==="/"
		// branch is redundant — both produce the same basePath.
		const basePath = stripTrailingSlashes(url.pathname);
		url.pathname = `${basePath}${normalizedApiPath}`;
		return url.toString();
	} catch {
		return `${stripTrailingSlashes(normalized)}${normalizedApiPath}`;
	}
}

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

export function buildOllamaApiUrl(endpoint: string, apiPath: `/api/${string}`): string {
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

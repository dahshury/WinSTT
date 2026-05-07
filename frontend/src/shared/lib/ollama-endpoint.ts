const TRAILING_API_PATH = /\/(?:api|v1)$/i;
const TRAILING_SLASHES = /\/+$/;

function stripTrailingSlashes(value: string): string {
	return value.replace(TRAILING_SLASHES, "");
}

export function normalizeOllamaEndpoint(endpoint: string): string {
	const trimmed = endpoint.trim();
	if (!trimmed) {
		return trimmed;
	}

	try {
		const url = new URL(trimmed);
		let pathname = stripTrailingSlashes(url.pathname);

		while (TRAILING_API_PATH.test(pathname)) {
			pathname = pathname.replace(TRAILING_API_PATH, "");
			pathname = stripTrailingSlashes(pathname);
		}

		url.pathname = pathname || "/";
		url.search = "";
		url.hash = "";

		return stripTrailingSlashes(url.toString());
	} catch {
		let normalized = stripTrailingSlashes(trimmed);
		while (TRAILING_API_PATH.test(normalized)) {
			normalized = normalized.replace(TRAILING_API_PATH, "");
			normalized = stripTrailingSlashes(normalized);
		}
		return normalized;
	}
}

export function buildOllamaApiUrl(endpoint: string, apiPath: `/api/${string}`): string {
	const normalized = normalizeOllamaEndpoint(endpoint);
	const normalizedApiPath = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;

	try {
		const url = new URL(normalized);
		const basePath = url.pathname === "/" ? "" : stripTrailingSlashes(url.pathname);
		url.pathname = `${basePath}${normalizedApiPath}`;
		return url.toString();
	} catch {
		return `${stripTrailingSlashes(normalized)}${normalizedApiPath}`;
	}
}

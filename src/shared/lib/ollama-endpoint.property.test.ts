import { describe, test } from "bun:test";
import fc from "fast-check";
import { buildOllamaApiUrl, normalizeOllamaEndpoint } from "./ollama-endpoint";

// Endpoint host arbitrary: http/https + simple host:port + optional path.
const schemeArb = fc.constantFrom("http", "https");
const hostArb = fc.constantFrom(
	"localhost",
	"example.com",
	"10.0.0.1",
	"host.local",
);
const portArb = fc.option(fc.integer({ min: 1, max: 65_535 }), {
	nil: undefined,
});
const basePathArb = fc.constantFrom("", "/proxy", "/sub/path", "/llm");

const validEndpointArb = fc
	.tuple(schemeArb, hostArb, portArb, basePathArb)
	.map(([scheme, host, port, base]) => {
		const portStr = port === undefined ? "" : `:${port}`;
		return `${scheme}://${host}${portStr}${base}`;
	});

const trailingSuffixArb = fc.constantFrom(
	"",
	"/",
	"//",
	"/api",
	"/v1",
	"/api/",
	"/v1/",
	"/api/v1",
	"/v1/api",
);

describe("normalizeOllamaEndpoint property tests", () => {
	test("idempotent: normalize(normalize(x)) === normalize(x)", () => {
		fc.assert(
			fc.property(validEndpointArb, trailingSuffixArb, (base, suffix) => {
				const input = `${base}${suffix}`;
				const once = normalizeOllamaEndpoint(input);
				const twice = normalizeOllamaEndpoint(once);
				return once === twice;
			}),
			{ numRuns: 300 },
		);
	});

	test("idempotent on arbitrary strings (must be total)", () => {
		fc.assert(
			fc.property(fc.string(), (input) => {
				const once = normalizeOllamaEndpoint(input);
				const twice = normalizeOllamaEndpoint(once);
				return once === twice;
			}),
			{ numRuns: 300 },
		);
	});

	test("output never ends with a trailing slash", () => {
		fc.assert(
			fc.property(fc.string(), (input) => {
				const out = normalizeOllamaEndpoint(input);
				return out === "" || !out.endsWith("/");
			}),
			{ numRuns: 300 },
		);
	});

	test("output never ends with /api or /v1 (case-insensitive)", () => {
		fc.assert(
			fc.property(validEndpointArb, trailingSuffixArb, (base, suffix) => {
				const out = normalizeOllamaEndpoint(`${base}${suffix}`);
				return !/\/(api|v1)$/i.test(out);
			}),
			{ numRuns: 300 },
		);
	});

	test("whitespace doesn't change the normalized value", () => {
		fc.assert(
			fc.property(validEndpointArb, trailingSuffixArb, (base, suffix) => {
				const input = `${base}${suffix}`;
				const padded = `   ${input}   `;
				return (
					normalizeOllamaEndpoint(input) === normalizeOllamaEndpoint(padded)
				);
			}),
			{ numRuns: 200 },
		);
	});
});

describe("buildOllamaApiUrl property tests", () => {
	test("output always contains the apiPath suffix verbatim", () => {
		fc.assert(
			fc.property(
				validEndpointArb,
				fc.constantFrom("/api/tags", "/api/show", "/api/chat"),
				(endpoint, apiPath) => {
					const out = buildOllamaApiUrl(endpoint, apiPath as `/api/${string}`);
					return out.endsWith(apiPath);
				},
			),
			{ numRuns: 200 },
		);
	});

	test("no double slashes around the api join point", () => {
		fc.assert(
			fc.property(
				validEndpointArb,
				trailingSuffixArb,
				fc.constantFrom("/api/tags", "/api/show"),
				(base, suffix, apiPath) => {
					const out = buildOllamaApiUrl(
						`${base}${suffix}`,
						apiPath as `/api/${string}`,
					);
					// Skip the protocol "://" portion when scanning for doubled slashes.
					const idx = out.indexOf("://");
					const afterScheme = idx === -1 ? out : out.slice(idx + 3);
					return !afterScheme.includes("//");
				},
			),
			{ numRuns: 300 },
		);
	});

	test("determinism: same (endpoint, apiPath) → same URL", () => {
		fc.assert(
			fc.property(
				validEndpointArb,
				trailingSuffixArb,
				fc.constantFrom("/api/tags", "/api/show"),
				(base, suffix, apiPath) => {
					const input = `${base}${suffix}`;
					const a = buildOllamaApiUrl(input, apiPath as `/api/${string}`);
					const b = buildOllamaApiUrl(input, apiPath as `/api/${string}`);
					return a === b;
				},
			),
			{ numRuns: 200 },
		);
	});
});

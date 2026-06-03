// Vendored copy of the app's `src/shared/lib/public-asset.ts`. This package is
// deliberately free of `@/shared/*` couplings (see package.json), so it carries
// its own copy of this tiny resolver. Keep the two in sync.

const LEADING_SLASH_RE = /^\/+/;

/**
 * Resolve a `public/` asset path against a renderer document.
 *
 * Pure core of {@link publicAsset}, split out so it can be unit-tested without
 * a live `window`. `protocol`/`href` are normally `window.location.protocol` /
 * `.href`.
 *
 * - Non-`file:` origins (the Vite dev server, test DOMs): the absolute
 *   `/foo.png` already resolves against the server root, so it's returned
 *   unchanged.
 * - `file:` origin (a packaged build): the main window is `<root>/index.html`
 *   and every secondary window is one level deep at `<root>/windows/<name>.html`.
 *   The asset is resolved against `<root>` regardless of which window asks, so
 *   `/foo.png` lands at `<root>/foo.png` instead of the filesystem drive root.
 */
export function resolvePublicAsset(path: string, protocol: string, href: string): string {
	const rel = path.replace(LEADING_SLASH_RE, "");
	if (protocol !== "file:") {
		return `/${rel}`;
	}
	const dir = new URL(".", href);
	const root = dir.pathname.endsWith("/windows/") ? new URL("../", dir) : dir;
	return new URL(rel, root).href;
}

/**
 * Resolve a `public/` asset referenced by an absolute `/foo.png` path so it
 * loads under both the dev server (http) and a packaged the reference build
 * (`file://`).
 *
 * `vite.config.ts` sets `base: "./"`, so Vite emits RELATIVE URLs for assets in
 * its module graph — but runtime string literals like the provider-icon paths
 * below are invisible to it and stay absolute. Under `file://` an absolute
 * `/provider-icons/x.png` resolves to the filesystem drive root and 404s; this
 * rewrites it to resolve against the renderer root instead.
 */
export function publicAsset(path: string): string {
	if (typeof window === "undefined") {
		return `/${path.replace(LEADING_SLASH_RE, "")}`;
	}
	return resolvePublicAsset(path, window.location.protocol, window.location.href);
}

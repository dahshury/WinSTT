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
 *   and every secondary window is one level deep at `<root>/windows/<name>.html`
 *   (see `electron/lib/renderer-url.ts`). The asset is resolved against
 *   `<root>` regardless of which window asks, so `/foo.png` lands at
 *   `<root>/foo.png` instead of the filesystem drive root.
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
 * Why this is needed: `vite.config.ts` sets `base: "./"`, so Vite emits
 * RELATIVE URLs for every asset in its module graph (JS, CSS, and CSS
 * `url()`s). But assets referenced as runtime string literals — e.g.
 * `<img src="/provider-icons/x.png">` — are invisible to Vite and stay
 * absolute. In dev they resolve against the dev-server root; in a packaged
 * build each window loads via `file://`, where `/foo.png` resolves to the
 * filesystem drive root (`file:///C:/foo.png`) and 404s. Wrap such paths in
 * `publicAsset(...)` to keep them working in both.
 */
export function publicAsset(path: string): string {
	if (typeof window === "undefined") {
		return `/${path.replace(LEADING_SLASH_RE, "")}`;
	}
	return resolvePublicAsset(path, window.location.protocol, window.location.href);
}
